/**
 * src/core/diagnostics.ts — 静默诊断服务（检测隐形化）
 *
 * 在后台聚合 6 类检测（兼容性 / EP / 功能性自检 / 内存守卫 / 模型校验 / Worker 状态），
 * 仅在有问题时经 eventBus 上报 DIAGNOSTIC_ISSUE；全通过时零打扰（不 emit 任何事件）。
 *
 * 设计依据：架构文档 §5.3 + PRD C 节（检测隐形化 + 分级提示）。
 * 本文件只「编排」既有检测逻辑，不重写任何算法。
 */

import { eventBus, AppEvents } from '@/core/eventBus';
import { BrowserCapability } from '@/core/browserCapability';
import { EPRouter } from '@/core/epRouter';
import { runSelfTest } from '@/pipeline/selfTest';
import { OrtSessionManager } from '@/core/ortSessionManager';
import { logger } from '@/core/logger';

/** 严重级（严格按 PRD C.2：critical / warning / info） */
export type Severity = 'critical' | 'warning' | 'info';

/** 诊断来源（用于归类与后续扩展） */
export type DiagnosticSource =
  | 'compatibility' | 'ep' | 'selftest' | 'memory' | 'model' | 'worker';

/** 单条诊断结果 —— 即通知中心消费的 DIAGNOSTIC_ISSUE 事件载荷 */
export interface DiagnosticResult {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  /** 可选操作按钮文案（critical modal / 个别 toast 使用） */
  actionLabel?: string;
  /** 点击操作按钮时执行的逻辑（如重新选择模型目录） */
  onAction?: () => void;
}

/** 诊断运行依赖（由 App 注入，避免诊断服务直接依赖 React 状态/生命周期） */
export interface DiagnosticRunnerDeps {
  /** 获取最新 OrtSessionManager（buffersReady 后用于功能性自检） */
  getSessionManager: () => OrtSessionManager | null;
  /** 请求重新选择模型目录（模型相关问题的兜底操作） */
  requestModelDir: () => void;
}

/**
 * 是否对「推荐能力缺失」发出 warning。
 *
 * 依据 PRD C.3 零打扰验收标准：正常环境（WebGPU 或本就不支持 WebGPU 的浏览器走 WASM）、
 * 模型加载成功、selfTest 全通过、内存平稳时，不出现任何 toast / 遮罩。
 * —— 推荐能力（WebGPU / FSAA / IndexedDB）在此应用中均有可用降级路径，
 *    其缺失属于「环境常态」而非异常（见架构 待确认 #6），故默认不提示。
 * 如产品后续决定更激进地告警，可将本开关置为 true。
 */
const EMIT_RECOMMENDED_WARNINGS = false;

let seq = 0;
function genId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/**
 * 静默诊断运行器：runAll() 后台跑全部启动期检测；runSelfTest() 在模型就绪后二次触发。
 * 每个问题经 eventBus.emit(DIAGNOSTIC_ISSUE) 上报；无问题则完全不 emit。
 */
export class DiagnosticRunner {
  private deps: DiagnosticRunnerDeps;
  private sessionManager: OrtSessionManager | null = null;
  private listeners = new Set<(r: DiagnosticResult) => void>();
  private eventUnsubs: Array<() => void> = [];
  private ranAll = false;

  constructor(deps: DiagnosticRunnerDeps) {
    this.deps = deps;
  }

  /** App 在 sessionManager 变化时调用，使诊断读取到最新实例 */
  setSessionManager(sm: OrtSessionManager | null): void {
    this.sessionManager = sm;
  }

  /** 订阅单条结果（供测试 / 扩展使用；通知中心主路径经 eventBus） */
  onResult(cb: (r: DiagnosticResult) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * 静默运行全部「启动期」检测。
   * 对每个问题 emit 一个 DIAGNOSTIC_ISSUE；无任何问题则完全不 emit（零打扰）。
   */
  async runAll(): Promise<void> {
    if (this.ranAll) return;
    this.ranAll = true;

    // 1) 兼容性 / 浏览器能力
    try {
      for (const r of runCompatibilityChecks()) {
        this.emit(r);
      }
    } catch (err) {
      logger.error('兼容性诊断失败:', err);
    }

    // 2) EP 能力（异步、自包含，不依赖 App 时序）
    try {
      for (const r of await runEPChecks()) {
        this.emit(r);
      }
    } catch (err) {
      logger.error('EP 诊断失败:', err);
    }

    // 3) 模型 / 功能性自检（buffers 就绪时顺带跑一次；否则稍后由 App 触发）
    await this.runSelfTest();

    // 4) 内存守卫降级 / Worker 状态：订阅事件，后续实时转诊断
    this.subscribeRuntimeEvents();
  }

  /**
   * 功能性自检（在 buffersReady 后由 App 二次触发）。
   * 内部判断 buffersReady，未就绪直接跳过。
   */
  async runSelfTest(): Promise<void> {
    const sm = this.deps.getSessionManager();
    if (!sm || !sm.buffersReady) return;
    try {
      for (const r of await runSelfTestChecks(sm, this.deps.requestModelDir)) {
        this.emit(r);
      }
    } catch (err) {
      logger.error('功能性自检诊断失败:', err);
    }
  }

  /** 释放：取消所有事件订阅、清空监听 */
  dispose(): void {
    for (const off of this.eventUnsubs) off();
    this.eventUnsubs = [];
    this.listeners.clear();
  }

  // ── 私有 ──

  private emit(result: DiagnosticResult): void {
    eventBus.emit(AppEvents.DIAGNOSTIC_ISSUE, result);
    for (const cb of this.listeners) {
      try {
        cb(result);
      } catch (err) {
        logger.error('诊断监听回调异常:', err);
      }
    }
  }

  private subscribeRuntimeEvents(): void {
    if (this.eventUnsubs.length > 0) return;
    this.eventUnsubs.push(
      eventBus.on(AppEvents.DEGRADE_CHANGED, (degraded: unknown) => {
        if (degraded === true) {
          this.emit({
            id: genId('memory'),
            severity: 'warning',
            title: '内存已达严重阈值',
            message:
              'JS 堆内存达到严重阈值，系统已自动降级：新推理任务将被拒绝，已有任务继续运行。',
          });
        }
      }),
      eventBus.on(AppEvents.WORKER_STATUS_CHANGED, (status: unknown) => {
        if (status === 'error') {
          this.emit({
            id: genId('worker'),
            severity: 'warning',
            title: '推理 Worker 异常',
            message: '推理 Worker 发生错误，正在尝试自动重建。',
          });
        }
      }),
    );
  }
}

// ── 检测源适配器（纯函数，复用既有检测逻辑，不改变算法） ──

/**
 * 兼容性检测：复用 BrowserCapability.detectAll()，
 * 把失败项映射为分级 DiagnosticResult。
 */
export function runCompatibilityChecks(): DiagnosticResult[] {
  const report = BrowserCapability.detectAll();
  const results: DiagnosticResult[] = [];

  for (const item of report.items) {
    if (item.supported) continue;

    if (item.severity === 'critical') {
      results.push({
        id: genId('compat'),
        severity: 'critical',
        title: `缺少关键能力：${item.label}`,
        message: item.detail ?? '该能力是应用运行的必要条件，请更换或调整浏览器环境后重试。',
        actionLabel: '重试',
        onAction: () => window.location.reload(),
      });
    } else if (item.severity === 'recommended') {
      // 见 EMIT_RECOMMENDED_WARNINGS 说明：默认不提示（零打扰）。
      if (EMIT_RECOMMENDED_WARNINGS) {
        results.push({
          id: genId('compat'),
          severity: 'warning',
          title: `推荐能力不可用：${item.label}`,
          message: item.detail ?? '部分增强功能可能不可用，但不影响核心流程。',
        });
      }
    }
    // optional 失败：一律不提示（零打扰）
  }

  return results;
}

/**
 * EP 检测：复用 EPRouter.detect() / selectEP()。
 * 仅当「WebGPU 本应可用却落到 WASM」时提示（真回退）；
 * 浏览器本就不支持 WebGPU → 正常 WASM 路径，非异常（待确认 #6）。
 */
async function runEPChecks(): Promise<DiagnosticResult[]> {
  const check = EPRouter.detect();
  if (!check.webgpuAvailable) return [];

  try {
    const selected = await EPRouter.selectEP();
    if (selected === 'wasm') {
      return [
        {
          id: genId('ep'),
          severity: 'warning',
          title: '已回退到 WASM CPU 推理',
          message:
            '当前环境 WebGPU 初始化失败，已回退至 CPU WASM 推理，合成速度会明显变慢。',
        },
      ];
    }
  } catch {
    return [
      {
        id: genId('ep'),
        severity: 'critical',
        title: '执行提供程序（EP）选择失败',
        message: '无法初始化 WebGPU 或 WASM 推理后端，语音合成功能将不可用。',
        actionLabel: '重试',
        onAction: () => window.location.reload(),
      },
    ];
  }
  return [];
}

/**
 * 功能性自检：复用 selfTest.runSelfTest()，按「全部失败 / 部分失败 / 全通过」评级。
 */
async function runSelfTestChecks(
  sm: OrtSessionManager,
  requestModelDir: () => void,
): Promise<DiagnosticResult[]> {
  const testResults = await runSelfTest(sm);
  const failed = testResults.filter((r) => !r.pass);
  if (failed.length === 0) return [];

  const failedNames = failed.map((r) => r.name).join('、');

  if (failed.length === testResults.length) {
    return [
      {
        id: genId('selftest'),
        severity: 'critical',
        title: '模型功能性自检全部失败',
        message: `以下模型自检未通过：${failedNames}。语音合成功能不可用，请检查模型文件是否完整。`,
        actionLabel: '重新选择模型目录',
        onAction: requestModelDir,
      },
    ];
  }

  return [
    {
      id: genId('selftest'),
      severity: 'warning',
      title: '部分模型自检未通过',
      message: `以下模型自检未通过：${failedNames}。受影响的功能可能无法正常工作。`,
      actionLabel: '重新选择模型目录',
      onAction: requestModelDir,
    },
  ];
}
