/**
 * src/types/worker.ts — Worker 通信相关类型定义
 *
 * 严格遵循 system_design.md §3.3 的消息协议定义。
 */

import type { ExecutionProvider } from './ep';

/** 主线程 → Worker 消息 */
export type OutboundMessage =
  | { type: 'init'; taskId: string; payload: { ortWasmPath: string; executionProvider: ExecutionProvider } }
  | { type: 'load_model'; taskId: string; payload: { modelName: string; buffer: ArrayBuffer } }
  | { type: 'run_inference'; taskId: string; payload: Record<string, unknown> }
  | { type: 'release_model'; taskId: string; payload: { modelName: string } }
  | { type: 'health_check'; taskId: string; payload: null }
  | { type: 'shutdown'; taskId: string; payload: null };

/** Worker → 主线程 消息 */
export type InboundMessage =
  | { type: 'progress'; taskId: string; payload: { stage: string; percent: number } }
  | { type: 'result'; taskId: string; payload: unknown }
  | { type: 'error'; taskId: string; payload: { code: string; message: string } }
  | { type: 'health_report'; taskId: string; payload: { memoryMB: number; taskCount: number; loadedModels: string[]; executionProvider: ExecutionProvider } };

/** 任务队列项 */
export interface TaskQueueItem {
  /** 任务唯一 ID */
  id: string;
  /** 消息类型 */
  type: string;
  /** 消息载荷 */
  payload: unknown;
  /** 优先级 */
  priority: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 任务状态 */
  status: 'queued' | 'running' | 'completed' | 'failed';
}

/** Worker 状态 */
export type WorkerStatus = 'idle' | 'busy' | 'error';

/** Worker 状态快照 */
export interface WorkerStatusSnapshot {
  status: WorkerStatus;
  taskCount: number;
  isRebuilding: boolean;
  memoryMB: number;
}
