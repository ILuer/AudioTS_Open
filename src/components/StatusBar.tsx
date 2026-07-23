/**
 * src/components/StatusBar.tsx — 底部状态栏（去 MUI 化）
 * ======================================================
 *
 * 用纯 HTML + 原型令牌（statusbar.css）重写，移除原 MUI 组件
 * （Paper/Stack/Typography/LinearProgress/Tooltip/Chip）及全部图标（改用 emoji）。
 *
 * 功能完全保留：
 *  - Worker 状态指示灯 / 重建中提示（useWorkerStatus）
 *  - 内存使用百分比 + 进度条 + 降级警告（useMemoryMonitor）
 *  - 推理锁状态（useWorkerStatus.locked）
 *  - EP 标识芯片 WebGPU / CPU WASM（useEPStatus）
 * 图标改用 emoji，无外部图标依赖。
 */

import { type FC, useState, useEffect, useCallback } from 'react';
import { useWorkerStatus } from '@/hooks/useWorkerStatus';
import { useMemoryMonitor } from '@/hooks/useMemoryMonitor';
import { useEPStatus } from '@/hooks/useEPStatus';
import { eventBus, AppEvents } from '@/core/eventBus';
import { logger } from '@/core/logger';
import type { OrtSessionManager } from '@/core/ortSessionManager';
import '@/styles/statusbar.css';

interface StatusMeta {
  color: string;
  label: string;
}

const STATUS_META: Record<string, StatusMeta> = {
  idle: { color: 'var(--color-success)', label: '空闲' },
  busy: { color: 'var(--color-warning)', label: '运行中' },
  error: { color: 'var(--color-error)', label: '异常' },
};

interface StatusBarProps {
  /** ORT Session 管理器（用于手动释放模型内存） */
  sessionManager: OrtSessionManager | null;
}

const StatusBar: FC<StatusBarProps> = ({ sessionManager }) => {
  const { status, locked, isRebuilding } = useWorkerStatus();
  const { snapshot, degraded, warning } = useMemoryMonitor();
  const { isWebGPU, isLoading: epLoading } = useEPStatus();

  // 模型目录是否已加载就绪（订阅 AppEvents.MODEL_DIR_READY，初始值取 window.__sm）
  const [modelReady, setModelReady] = useState<boolean>(
    !!((window as unknown as { __sm?: { buffersReady?: boolean } }).__sm?.buffersReady),
  );
  // 释放中状态（防止重复点击）
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    const off = eventBus.on(AppEvents.MODEL_DIR_READY, (ready: unknown) =>
      setModelReady(Boolean(ready)),
    );
    return off;
  }, []);

  // 手动释放模型内存（Worker session + 主线程 buffer，彻底回收 JS 堆）
  const handleFreeMemory = useCallback(async () => {
    if (!sessionManager || releasing) return;
    setReleasing(true);
    try {
      await sessionManager.freeMemory();
      // 通知全局：模型已卸载，状态栏恢复「点击加载」入口
      eventBus.emit(AppEvents.MODEL_DIR_READY, false);
      logger.interactive('System', '已释放模型内存，JS 堆已回收。重新合成需先选择模型目录。');
    } catch (err) {
      logger.error('释放模型内存失败:', err);
    } finally {
      setReleasing(false);
    }
  }, [sessionManager, releasing]);

  const meta = STATUS_META[status] ?? STATUS_META.idle;

  const displayUsed = sessionManager ? sessionManager.getDisplayUsedBytes() : (snapshot?.usedJSHeapSize ?? 0);
  const usedMB = (displayUsed / (1024 * 1024)).toFixed(0);
  const limitMB = snapshot ? (snapshot.jsHeapSizeLimit / (1024 * 1024)).toFixed(0) : '—';
  const memoryPercent =
    snapshot && snapshot.jsHeapSizeLimit > 0
      ? (displayUsed / snapshot.jsHeapSizeLimit) * 100
      : 0;

  const barColor = degraded || warning ? 'var(--color-error)' : 'var(--brand)';

  return (
    <footer className={`statusbar${degraded ? ' is-degraded' : ''}`}>
      {/* Worker 状态 */}
      <div
        className="sb-item sb-worker"
        title={`Worker: ${meta.label}${isRebuilding ? ' (重建中...)' : ''}`}
      >
        <span className="sb-dot" style={{ background: meta.color }} aria-hidden="true" />
        <span className="sb-text sb-mono">
          {isRebuilding ? 'Worker 🔄' : `Worker ${meta.label}`}
        </span>
      </div>

      {/* EP 标识芯片 */}
      {!epLoading && (
        <div
          className="sb-item sb-ep"
          title={isWebGPU ? 'WebGPU 加速推理（GPU 零拷贝）' : 'CPU WASM 推理'}
        >
          <span className={`sb-chip ${isWebGPU ? 'gpu' : 'cpu'}`}>
            {isWebGPU ? '⚡ WebGPU' : '🧠 CPU WASM'}
          </span>
        </div>
      )}

      {/* 模型目录加载状态（未加载时可点击手动恢复，解耦于试听/配音） */}
      {modelReady ? (
        <div className="sb-item sb-model" title="模型目录已加载完成">
          <span className="sb-text sb-mono">✓ 模型已加载</span>
        </div>
      ) : (
        <div
          className="sb-item sb-model warn"
          title="点击重新选择模型目录"
          style={{ cursor: 'pointer', color: 'var(--color-error)' }}
          onClick={() => (window as unknown as { __loadModels?: () => void }).__loadModels?.()}
        >
          <span className="sb-text sb-mono">⚠ 模型未加载 · 点击加载</span>
        </div>
      )}

      {/* 内存使用 */}
      <div className="sb-item sb-mem" title={`JS堆: ${usedMB} MB / ${limitMB} MB`}>
        <span className="sb-text sb-mono">
          {usedMB}/{limitMB} MB
        </span>
        <span className="sb-progress" aria-hidden="true">
          <i style={{ width: `${Math.min(memoryPercent, 100)}%`, background: barColor }} />
        </span>
        <span className="sb-text sb-mono">{memoryPercent.toFixed(0)}%</span>
      </div>

      {/* 手动释放模型内存 */}
      {(releasing || sessionManager?.buffersReady) && (
        <div
          className="sb-item sb-free"
          title={releasing ? '正在释放模型内存...' : '释放模型内存（Worker session + 主线程 buffer），回收 JS 堆'}
          style={{
            cursor: releasing ? 'default' : 'pointer',
            color: releasing ? 'var(--text-muted)' : 'var(--brand)',
          }}
          onClick={releasing ? undefined : handleFreeMemory}
        >
          <span className="sb-text sb-mono">{releasing ? '⏳ 释放中' : '🧹 释放内存'}</span>
        </div>
      )}

      {/* 锁状态 */}
      <div
        className="sb-item sb-lock"
        title={locked ? '推理锁已锁定 (任务执行中)' : '推理锁已释放'}
      >
        <span className="sb-text sb-mono">{locked ? '🔒 锁' : '🔓 空闲'}</span>
      </div>

      {/* 降级警告 */}
      {degraded && (
        <div
          className="sb-item sb-warn"
          title="内存使用超过严重阈值，系统已自动降级。新推理任务被拒绝，已有任务继续运行。"
        >
          <span className="sb-text sb-mono">⚠ 降级</span>
        </div>
      )}
    </footer>
  );
};

export default StatusBar;
