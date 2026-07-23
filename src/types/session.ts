/**
 * src/types/session.ts — ORT Session 相关类型定义
 */

import type { ExecutionProvider } from './ep';

/** Session 配置 */
export interface SessionConfig {
  /** 模型文件完整路径 */
  modelPath: string;
  /** 执行提供程序 */
  executionProvider: ExecutionProvider;
  /** 是否启用图优化 */
  enableGraphOptimization: boolean;
  /** 日志严重级别 (0-4) */
  logSeverity: number;
}

/** Session 句柄（主线程侧追踪） */
export interface SessionHandle {
  /** 模型名称 */
  modelName: string;
  /** 模型路径 */
  modelPath: string;
  /** 是否已加载 */
  isLoaded: boolean;
  /** 预估内存占用 (MB) */
  memoryEstimateMB: number;
  /** ONNX 输入名列表（用于 KV-cache 等按名构造 feed，如 talker_cache 的 past_* 张量） */
  inputNames?: string[];
  /** ONNX 输出名列表（用于按名读取多输出模型的返回值，如 talker_cache 的 logits/hidden/present_*） */
  outputNames?: string[];
}

/** Session 状态 */
export type SessionState = 'idle' | 'loading' | 'ready' | 'releasing' | 'error';

/** Session 事件 */
export interface SessionEvent {
  type: 'session_created' | 'session_released' | 'session_error';
  modelName: string;
  timestamp: number;
  detail?: string;
}
