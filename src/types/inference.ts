/**
 * src/types/inference.ts — 推理相关类型定义
 */

/** 推理结果 */
export interface InferenceResult {
  /** 是否成功 */
  success: boolean;
  /** 输出数据 */
  data: ArrayBuffer | Float32Array | Int32Array | null;
  /** 耗时 (ms) */
  durationMs: number;
  /** 错误信息（失败时有值） */
  error?: string;
}

/** 自检报告 */
export interface SelfTestReport {
  /** 是否通过 */
  passed: boolean;
  /** 余弦相似度 */
  cosineSimilarity: number;
  /** 判定阈值 */
  threshold: number;
  /** 总耗时 (ms) */
  durationMs: number;
  /** 各阶段名称 */
  stages: string[];
  /** 错误信息（失败时有值） */
  error: string | null;
}

/** 内存快照 */
export interface MemorySnapshot {
  /** JS 堆大小上限 (bytes) */
  jsHeapSizeLimit: number;
  /** 已分配 JS 堆总大小 (bytes) */
  totalJSHeapSize: number;
  /** 已使用 JS 堆大小 (bytes) */
  usedJSHeapSize: number;
  /** 快照时间戳 */
  timestamp: number;
}
