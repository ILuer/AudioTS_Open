/**
 * src/core/logger.ts — 统一日志（三类语义：interactive / warn / error）
 *
 * 全项目唯一允许直接调用 console 的模块（内部用 console.info / warn / error）。
 * 其它任何文件禁止直接使用 console.log / info / debug / trace / warn / error，
 * 统一经本模块输出，确保控制台仅保留「交互信息 / 警告信息 / 错误信息」三类语义日志。
 *
 * 设计依据：架构文档 §5.4 + PRD D.3（三类契约，移除 [Qwen3TTS] 等过程前缀）。
 */

export type LogLevel = 'interactive' | 'warn' | 'error';

/** 统一前缀，便于在控制台中区分 AudioTS 输出 */
const PREFIX = '[AudioTS]';

/** 开发开关：true 时抑制 interactive 类输出（warn / error 仍输出） */
let quiet = false;

/** 设置开发开关（可选，用于隐藏交互噪音） */
export function setQuiet(value: boolean): void {
  quiet = value;
}

/** 拼接前缀 + 主消息 + 附加参数 */
function buildArgs(message: string, args: unknown[]): unknown[] {
  return [PREFIX, message, ...args];
}

/**
 * 交互信息（用户操作反馈 / 状态转变）→ console.info
 * 例：模型目录已保存、已删除音色档案
 */
export function interactive(message: string, ...args: unknown[]): void {
  if (quiet) return;
  // eslint-disable-next-line no-console
  console.info(...buildArgs(message, args));
}

/**
 * 警告信息（非阻断异常）→ console.warn
 * 例：WASM 回退、内存接近阈值、模型部分缺失、Worker 重建
 */
export function warn(message: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn(...buildArgs(message, args));
}

/**
 * 错误信息（阻断 / 失败）→ console.error
 * 例：推理失败、模型加载失败、EP 选择失败、未捕获异常
 */
export function error(message: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(...buildArgs(message, args));
}

/** 统一日志对象，供 `import { logger } from '@/core/logger'` 使用 */
export const logger = {
  interactive,
  warn,
  error,
  setQuiet,
};

export default logger;
