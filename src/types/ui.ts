/**
 * src/types/ui.ts — UI 状态相关类型定义
 */

import type { WorkerStatus } from './worker';
import type { ExecutionProvider } from './ep';

/** 当前激活的 Tab */
export type TabId = 'compatibility' | 'models' | 'selftest' | 'perf' | 'voice-design';

/** 全局 UI 状态 */
export interface UIState {
  /** 当前激活 Tab */
  activeTab: TabId;
  /** 是否正在加载 */
  loading: boolean;
  /** 全局错误信息 */
  error: string | null;
}

/** 底部状态栏状态 */
export interface StatusBarState {
  /** Worker 状态指示 */
  workerStatus: WorkerStatus;
  /** 内存使用百分比 (0-100) */
  memoryPercent: number;
  /** 全局推理锁 */
  locked: boolean;
  /** 降级模式 */
  degraded: boolean;
  /** Worker 是否正在重建 */
  isRebuilding: boolean;
}

// ── P2 性能指标类型 ──

/** 单次推理性能指标 */
export interface PerfMetric {
  /** 记录时间戳 */
  timestamp: number;
  /** 推理耗时 (ms) */
  durationMs: number;
  /** 模型名称 */
  modelName: string;
  /** 执行提供程序 */
  ep: ExecutionProvider;
  /** 是否为预热推理（warmup run） */
  isWarmup: boolean;
}

/** 性能汇总统计 */
export interface PerfSummary {
  /** 总推理次数 */
  totalCount: number;
  /** 平均耗时 (ms) */
  avgMs: number;
  /** 最小耗时 (ms) */
  minMs: number;
  /** 最大耗时 (ms) */
  maxMs: number;
  /** P50 中位数 (ms) */
  p50Ms: number;
  /** P95 (ms) */
  p95Ms: number;
  /** 最近 N 次推理指标 */
  recentMetrics: PerfMetric[];
}
