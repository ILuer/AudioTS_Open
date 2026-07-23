/**
 * src/types/compatibility.ts — 浏览器兼容性相关类型定义
 */

/** 单个兼容性检测项 */
export interface CompatibilityItem {
  /** 检测项唯一标识（sharedArrayBuffer, wasmSimd, webgpu, fileSystemAccess, audioContext, indexedDB, webCrypto） */
  key: string;
  /** 人类可读标签 */
  label: string;
  /** 是否支持 */
  supported: boolean;
  /** 详细信息（版本号或不支持的说明） */
  detail: string | null;
  /** 严重级别：critical | recommended | optional */
  severity: 'critical' | 'recommended' | 'optional';
}

/** 浏览器等级 */
export type BrowserGrade = 'full' | 'partial' | 'unavailable';

/** 兼容性检测报告 */
export interface CompatibilityReport {
  /** 检测时间戳 */
  timestamp: number;
  /** User-Agent 字符串 */
  userAgent: string;
  /** 浏览器名称 */
  browserName: string;
  /** 浏览器版本 */
  browserVersion: string;
  /** 各检测项结果 */
  items: CompatibilityItem[];
  /** 总体等级 */
  grade: BrowserGrade;
  /** 通过数量 */
  passedCount: number;
  /** 总检数量 */
  totalCount: number;
}
