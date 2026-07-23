/**
 * App.tsx — 应用根组件（WebGPU 升级版 · 融合外壳）
 *
 * 外壳：TopBar（品牌 + 主题切换 + 用户 chip）
 *      + TabBar（调音台）
 *      + 内容区（渲染对应 Tab 面板）
 *      + StatusBar（保留）+ ModelDirDialog（保留）。
 *
 * 完整保留现有初始化逻辑：
 *   - EP 选择 useEffect
 *   - OrtSessionManager / WorkerManager 初始化
 *   - buffers 注入
 *   - ModelDirDialog 弹窗触发（首次无 buffer 自动弹、失败重弹）
 *   - window 调试钩子（__loadModels / __showModelDir / __sm 等）
 */

import React, { type FC, useState, useEffect, useRef, useCallback } from 'react';
import VoiceDesignTab from '@/components/VoiceDesignTab';
import DubbingTab from '@/components/DubbingTab';
import StatusBar from '@/components/StatusBar';
import { ModelDirDialog } from '@/components/ModelDirDialog';
import { TopBar } from '@/components/TopBar';
import { TabBar, type TabItem } from '@/components/TabBar';
import { EPRouter } from '@/core/epRouter';
import { eventBus, AppEvents } from '@/core/eventBus';
import { OrtSessionManager } from '@/core/ortSessionManager';
import { WorkerManager } from '@/worker/workerManager';
import type { EPStatus } from '@/types';
import { ConfigError } from '@/types/encoding';
import { getVoiceDesignModelDir } from '@/core/constants';
import { loadConfigFromJSON } from '@/core/configLoader';
import { encodingRegistry } from '@/core/encodingRegistry';
import { logger } from '@/core/logger';
import NotificationCenter from '@/components/NotificationCenter';
import { DiagnosticRunner } from '@/core/diagnostics';

// 「调音台」+「配音台」两个工作区（Phase 4 + Phase 5），顺序与原型一致：调音台在前，配音台在后。
const TABS: TabItem[] = [
  { id: 'voice', label: '调音台', icon: '🎚' },
  { id: 'dubbing', label: '配音台', icon: '🎬' },
];

interface TabPanelProps {
  children: React.ReactNode;
  index: number;
  value: number;
  id: string;
}

function TabPanel({ children, index, value, id }: TabPanelProps) {
  return (
    <div
      className={`tabpanel ${value === index ? '' : 'is-hidden'}`}
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={value !== index}
    >
      {children}
    </div>
  );
}

/** ErrorBoundary — 全局错误兜底 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('全局未捕获错误:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="content">
          <div className="panel" role="alert">
            <h2 style={{ margin: '0 0 8px', color: 'var(--text-strong)' }}>应用发生错误</h2>
            <p style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-body)', margin: '0 0 12px' }}>
              {this.state.error?.message || '未知错误'}
            </p>
            <p style={{ color: 'var(--text-soft)', margin: 0 }}>
              请刷新页面重试。如问题持续，请检查浏览器兼容性。
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const App: FC = () => {
  const [tabIndex, setTabIndex] = useState(0);
  const [epInitialized, setEpInitialized] = useState(false);
  const [sessionManager, setSessionManager] = useState<OrtSessionManager | null>(null);
  const [modelDirDialogOpen, setModelDirDialogOpen] = useState(false);
  const [modelDirError, setModelDirError] = useState<string | undefined>(undefined);
  const workerManagerRef = useRef<WorkerManager | null>(null);
  const [buffers, setBuffers] = useState<Map<string, ArrayBuffer>>(new Map());

  // 模型目录自动弹窗守卫：保证整个会话只自动弹一次（挡住 StrictMode 双调用 / 重复渲染）
  const modelDirPromptedRef = useRef(false);

  // ── 启动时 EP 选择 ──
  useEffect(() => {
    const initEP = async () => {
      try {
        EPRouter.clearCache(); // 开发阶段每次刷新重新检测 EP
        const checkResult = EPRouter.detect();
        const provider = await EPRouter.selectEP();
        const isCached = EPRouter.getCachedEP() === provider;

        const status: EPStatus = {
          activeProvider: provider,
          isWebGPU: provider === 'webgpu',
          checkResult,
          cached: isCached,
        };

        // 真实检测结果推送：保留 detect()/selectEP() 得到的 activeProvider/isWebGPU，
        // 不再强制覆盖为 wasm/false，以保持 StatusBar 与运行时一致。
        eventBus.emit(AppEvents.EP_CHANGED, { ...status });
        setEpInitialized(true);
      } catch (err) {
        logger.error('EP 选择失败:', err);
        // 即使失败也标记为已初始化，使用 WASM 作为默认值
        const fallbackStatus: EPStatus = {
          activeProvider: 'wasm',
          isWebGPU: false,
          checkResult: {
            provider: 'wasm',
            webgpuAvailable: false,
            webgpuReason: `EP 选择失败: ${String(err)}`,
            browserName: 'Unknown',
            browserVersion: 'Unknown',
            chromeVersion: 0,
            gpuAdapterInfo: null,
          },
          cached: false,
        };
        eventBus.emit(AppEvents.EP_CHANGED, fallbackStatus);
        setEpInitialized(true);
      }
    };

    initEP();
  }, []);

  // ── 初始化 OrtSessionManager（EP 就绪后） ──
  useEffect(() => {
    if (!epInitialized) return;

    const initSession = async () => {
      try {
        const ep = EPRouter.getCachedEP() || 'wasm';
        const wm = new WorkerManager();
        await wm.initialize('/ort/', ep);
        workerManagerRef.current = wm;

        const sm = new OrtSessionManager(wm, ep, getVoiceDesignModelDir());
        setSessionManager(sm);
        (window as any).__sm = sm;
      } catch (err) {
        logger.error('OrtSessionManager 初始化失败:', err);
        // 即使失败也允许继续（VoiceDesignTab 会显示模型未就绪）
      }
    };

    initSession();
  }, [epInitialized]);

  // ── 注入模型 buffer 到 sessionManager（按需惰性加载） ──
  useEffect(() => {
    if (sessionManager && buffers.size > 0) {
      sessionManager.setBuffers(buffers);
    }
  }, [sessionManager, buffers]);

  // 暴露 re-pick 函数：加载失败时重新弹出目录选择器
  const showModelDirPicker = useCallback((error?: string) => {
    if (error) setModelDirError(error);
    setModelDirDialogOpen(true);
  }, []);

  // ── loadModels → 重新弹出目录选择器（webkitdirectory 方式） ──
  useEffect(() => {
    (window as any).__loadModels = () => setModelDirDialogOpen(true);
  }, []);

  // 暴露 showModelDirPicker 到 window（模型加载失败时触发）
  useEffect(() => {
    (window as any).__showModelDir = showModelDirPicker;
  }, [showModelDirPicker]);

  // ── 静默诊断运行器（仅编排，不改检测算法）──
  // getSessionManager 经 ref 读取最新实例，避免闭包捕获过期值。
  const sessionManagerRef = useRef<OrtSessionManager | null>(null);
  const diagnosticRunnerRef = useRef<DiagnosticRunner | null>(null);
  if (diagnosticRunnerRef.current === null) {
    diagnosticRunnerRef.current = new DiagnosticRunner({
      getSessionManager: () => sessionManagerRef.current,
      requestModelDir: () => showModelDirPicker(),
    });
  }

  // 同步最新 sessionManager 到诊断运行器
  useEffect(() => {
    sessionManagerRef.current = sessionManager;
    diagnosticRunnerRef.current?.setSessionManager(sessionManager);
  }, [sessionManager]);

  // 挂载后静默跑全部启动期检测；queueMicrotask 确保 NotificationCenter 订阅已建立，避免事件丢失
  useEffect(() => {
    const runner = diagnosticRunnerRef.current;
    if (!runner) return;
    queueMicrotask(() => {
      runner.runAll().catch((err) => logger.error('静默诊断运行失败:', err));
    });
  }, []);

  // 模型 buffer 就绪后触发功能性自检并上报
  useEffect(() => {
    if (sessionManager?.buffersReady) {
      diagnosticRunnerRef.current
        ?.runSelfTest()
        .catch((err) => logger.error('功能性自检触发失败:', err));
    }
  }, [sessionManager, buffers]);

  // 改进依据: 状态盘点报告 P0-2 — 页面关闭前释放 GPU 资源
  // beforeunload 作为最后防线：通知 WorkerManager 执行 shutdown，防止 GPU 显存泄漏。
  useEffect(() => {
    const handleBeforeUnload = () => {
      eventBus.emit(AppEvents.SHUTDOWN, {});
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // 首次打开 → 如果没有注入过 buffer，弹出目录选择器（严格只弹一次）
  useEffect(() => {
    if (!sessionManager) return;
    if (!modelDirPromptedRef.current && !sessionManager.buffersReady) {
      modelDirPromptedRef.current = true;
      setModelDirDialogOpen(true);
    }
  }, [sessionManager]);

  return (
    <ErrorBoundary>
      <NotificationCenter />

      <div className="app-shell">
        <TopBar />
        <TabBar tabs={TABS} value={tabIndex} onChange={setTabIndex} />

        <ModelDirDialog
          open={modelDirDialogOpen}
          onConfigured={async (files: File[]) => {
            setModelDirDialogOpen(false);
            setModelDirError(undefined);
            // 读取 ONNX + 全部 JSON/TXT 配置文件
            const bufMap = new Map<string, ArrayBuffer>();
            const textMap = new Map<string, string>();
            for (const f of files) {
              if (f.name.endsWith('.onnx')) {
                bufMap.set(f.name, await f.arrayBuffer());
              } else if (f.name.endsWith('.json') || f.name.endsWith('.txt')) {
                textMap.set(f.name, await f.text());
              }
            }
            // 解析并初始化配置驱动编码
            try {
              const config = loadConfigFromJSON(textMap);
              encodingRegistry.initialize(config);
            } catch (err) {
              const msg = err instanceof ConfigError ? err.message : String(err);
              logger.error('配置加载失败:', msg);
              setModelDirError(msg);
              return;
            }
            // 存储 BPE 文本供 Tokenizer 后续加载（保持兼容）
            if (textMap.has('vocab.json')) (window as any).__bpe_vocab_json = textMap.get('vocab.json');
            if (textMap.has('merges.txt')) (window as any).__bpe_merges_txt = textMap.get('merges.txt');
            if (textMap.has('tokenizer_config.json')) (window as any).__bpe_tokenizer_config_json = textMap.get('tokenizer_config.json');
            if (sessionManager && bufMap.size > 0) {
              sessionManager.setBuffers(bufMap);
              // 模型就绪 → 同步到诊断运行器并触发功能性自检上报
              diagnosticRunnerRef.current?.setSessionManager(sessionManager);
              diagnosticRunnerRef.current
                ?.runSelfTest()
                .catch((err) => logger.error('功能性自检触发失败:', err));
              // 模型目录加载完成 → 广播就绪事件，供 StatusBar 展示恢复入口
              eventBus.emit(AppEvents.MODEL_DIR_READY, true);
            }
          }}
          errorMessage={modelDirError}
        />

        <div className="content">
          <TabPanel value={tabIndex} index={0} id="voice">
            <VoiceDesignTab
              sessionManager={sessionManager}
              buffersReady={sessionManager?.buffersReady ?? false}
            />
          </TabPanel>
          <TabPanel value={tabIndex} index={1} id="dubbing">
            <DubbingTab
              sessionManager={sessionManager}
              buffersReady={sessionManager?.buffersReady ?? false}
            />
          </TabPanel>
        </div>

        <StatusBar sessionManager={sessionManager} />
      </div>
    </ErrorBoundary>
  );
};

export default App;
