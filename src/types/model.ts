/**
 * src/types/model.ts — 模型相关类型定义
 *
 * 严格遵循 system_design.md §3.1 中 class-diagram 的定义。
 */

/** AppError — 统一错误类型，符合 system_design.md §8.2 */
export class AppError extends Error {
  public readonly code: string;
  public readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }
}

/** 模型加载状态枚举 */
export enum ModelStatus {
  PENDING = 'PENDING',
  LOADING = 'LOADING',
  LOADED = 'LOADED',
  VERIFIED = 'VERIFIED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

/** 模型文件元信息（来自 MODEL_CHECKSUMS.txt） */
export interface ModelFileInfo {
  /** 文件名（如 'talker.onnx'） */
  filename: string;
  /** 期望体积（字节） */
  sizeBytes: number;
  /**
   * 期望 SHA-256 哈希（hex 小写）。
   * 允许为空字符串 '' —— 此时 ModelLoader 跳过 SHA-256 校验（如 VoiceDesign 集尚未补全实测值）。
   */
  sha256?: string;
  /** 是否为必需文件 */
  required: boolean;
  /**
   * 是否执行 SHA-256 校验（可选）。
   * 未设置时由 ModelLoader 自行决定：sha256 为空则跳过，非空则校验。
   */
  verifySha256?: boolean;
}

/** 单个模型文件的加载状态 */
export interface ModelLoadState {
  /** 关联的模型文件元信息 */
  file: ModelFileInfo;
  /** 当前状态 */
  status: ModelStatus;
  /** 错误信息（FAILED 时有值） */
  error: string | null;
  /** 加载进度 0-100 */
  progress: number;
  /** 加载开始时间戳 (ms) */
  loadStartMs: number;
  /** 加载结束时间戳 (ms) */
  loadEndMs: number;
}

/** 模型加载器配置 */
export interface ModelLoaderConfig {
  /** 模型目录路径 */
  modelDir: string;
  /** 是否启用 SHA-256 校验 */
  enableSha256: boolean;
  /** 单文件加载超时 (ms) */
  loadTimeoutMs: number;
  /** 进度回调 */
  onProgress?: (filename: string, status: ModelStatus, progress: number) => void;
  /** 目标模型集（Base 默认；VoiceDesign 传入 VOICEDESIGN_MODEL_SET）。决定目录与文件清单 */
  modelSet?: import('../core/modelSet').ModelSet;
}

/** 模型加载模式 */
export type ModelMode = 'dev' | 'prod';

/** 模型加载总体结果 */
export interface ModelLoadResult {
  success: boolean;
  dirHandle: FileSystemDirectoryHandle | null;
  states: ModelLoadState[];
  needsUserDownload: boolean;
  errorMessage?: string;
  /** 已获取的原始模型 buffer（key=文件名），供上层加载进 OrtSessionManager */
  buffers?: Map<string, ArrayBuffer>;
}

/** 下载指引数据结构 */
export interface DownloadGuideData {
  huggingFaceUrl: string;
  targetDir: string;
  totalSize: string;
  fileCount: number;
  models: ModelFileInfo[];
  installSteps: string[];
}
