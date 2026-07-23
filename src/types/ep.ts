/**
 * src/types/ep.ts — 执行提供程序（Execution Provider）相关类型定义
 *
 * 定义 WebGPU / WASM EP 选择、检测结果与运行时状态类型。
 */

/** 支持的执行提供程序 */
export type ExecutionProvider = 'webgpu' | 'wasm';

/** EP 检测结果 */
export interface EPCheckResult {
  /** 推荐的执行提供程序 */
  provider: ExecutionProvider;
  /** WebGPU API 是否可用 */
  webgpuAvailable: boolean;
  /** WebGPU 不可用的原因（可用时为空字符串） */
  webgpuReason: string;
  /** 浏览器名称 */
  browserName: string;
  /** 浏览器版本 */
  browserVersion: string;
  /** Chrome 主版本号（非 Chrome/Edge 为 0） */
  chromeVersion: number;
  /** GPU 适配器信息（WebGPU 可用时获取，否则为 null） */
  gpuAdapterInfo: { vendor: string; architecture: string; description?: string } | null;
}

/** EP 运行时状态 */
export interface EPStatus {
  /** 当前激活的执行提供程序 */
  activeProvider: ExecutionProvider;
  /** 是否为 WebGPU */
  isWebGPU: boolean;
  /** EP 检测结果 */
  checkResult: EPCheckResult;
  /** 是否来自 sessionStorage 缓存 */
  cached: boolean;
}
