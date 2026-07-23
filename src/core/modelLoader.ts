/**
 * ONNX 模型加载器（状态机版）
 * =========================
 * 改进依据: 反思报告 P1-3 — 需设计渐进式模型加载策略
 * 
 * 状态机：PENDING → LOADING → LOADED → VERIFIED
 *                                → FAILED
 *                      LOADED   → FAILED
 *                               → SKIPPED
 * 
 * dev 模式：通过 fetch/Vite 静态文件服务读取 Models/ 目录
 * prod 模式：FSAA 自动获取 / 用户手动选择 → SHA-256 校验
 * 
 * 当前行为: 全量加载
 *   - 所有 8 个 VoiceDesign 模型文件一次性加载（~2.7GB）
 *   - 用户需等待全部模型就绪后才能使用任何功能
 * 
 * 渐进式加载策略（未来改进）:
 *   阶段1（建档模式）: 仅需 ~460MB
 *     - text_embed.onnx (~80MB)
 *     - codec_embed.onnx (~80MB)  
 *     - tok_encoder.onnx (~300MB)
 *   阶段2（合成模式）: 追加 ~2.24GB
 *     - talker.onnx + talker_cache.onnx (~1.7GB)
 *     - code_predictor.onnx (~150MB)
 *     - residual_embed.onnx (~80MB)
 *     - tok_decoder.onnx (~310MB)
 * 
 * UI 集成建议:
 *   - 阶段1完成后启用"音色建档"Tab
 *   - 阶段2完成后启用"语音合成"Tab
 *   - 状态栏显示当前已加载模型百分比
 * 
 * 预期效果:
 *   - 用户可提前进入建档环节，减少初始等待时间
 *   - 降低首屏白屏感知时间
 * 
 * 反思报告指出:
 *   - R-12: 缺乏渐进式功能可用性设计影响用户体验
 *   - P1-3: 应优先实现建档模式的部分模型加载
 */

import {
  getVoiceDesignModelDir,
  VOICEDESIGN_MODEL_FILES,
  MODEL_LOAD_TIMEOUT_MS,
  HF_MODEL_URL,
} from '@/core/constants';
import { Sha256Calculator } from '@/core/sha256';
import { eventBus, AppEvents } from '@/core/eventBus';
import { getModelPath, getManifestPath } from '@/core/modelSet';
import type { ModelSet } from '@/core/modelSet';
import {
  ModelStatus,
  AppError,
  type ModelFileInfo,
  type ModelLoadState,
  type ModelLoaderConfig,
  type ModelMode,
  type ModelLoadResult,
  type DownloadGuideData,
} from '@/types';
import { logger } from '@/core/logger';

// ── 默认配置 ──
const DEFAULT_CONFIG: ModelLoaderConfig = {
  modelDir: getVoiceDesignModelDir(),
  enableSha256: true,
  loadTimeoutMs: MODEL_LOAD_TIMEOUT_MS,
};

/**
 * 获取当前运行模式
 */
export function getModelMode(): ModelMode {
  const env = import.meta.env?.VITE_APP_MODE;
  if (env === 'dev') return 'dev';

  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'dev') return 'dev';
  }

  return 'prod';
}

/**
 * 格式化文件大小（人类可读）
 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ── 下载指引共享逻辑 ──

/** 构建下载指引数据（避免重复） */
function buildDownloadGuideData(set: ModelSet = { id: 'voicedesign', dir: getVoiceDesignModelDir(), files: VOICEDESIGN_MODEL_FILES, manifestDriven: false }): DownloadGuideData {
  const totalBytes = set.files.reduce((sum, m) => sum + m.sizeBytes, 0);
  const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);

  return {
    huggingFaceUrl: HF_MODEL_URL,
    targetDir: set.dir,
    totalSize: `${totalGB} GB`,
    fileCount: set.files.length,
    models: set.files,
    installSteps: [
      `1. 访问 ${HF_MODEL_URL}`,
      `2. 下载全部 ${set.files.length} 个 .onnx 文件 + manifest.json`,
      `3. 将文件放入项目目录: ${set.dir}/`,
      '4. 刷新页面或点击「重新检测」',
    ],
  };
}

// ── AbortSignal 组合工具 ──

/** 组合两个 AbortSignal：任一 abort 则结果 abort */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted || b.aborted) return AbortSignal.abort(a.aborted ? a.reason : b.reason);
  const controller = new AbortController();
  const onAbort = (reason: unknown) => controller.abort(reason);
  a.addEventListener('abort', () => onAbort(a.reason), { once: true });
  b.addEventListener('abort', () => onAbort(b.reason), { once: true });
  return controller.signal;
}

/**
 * 模型加载器类
 *
 * 管理 VoiceDesign 8 个模型文件的完整加载生命周期（FSAA 读取 → SHA-256 校验 → 状态流转）。
 */
export class ModelLoader {
  private config: ModelLoaderConfig;
  private modelSet: ModelSet;
  private states: ModelLoadState[];
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private abortController: AbortController | null = null;
  /** 已获取的原始模型 buffer（供 sessionManager 加载用）；按文件名索引 */
  private buffers: Map<string, ArrayBuffer> = new Map();

  constructor(config?: Partial<ModelLoaderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 目标模型集：默认 VoiceDesign；可通过 config 覆盖
    const defaultDir = getVoiceDesignModelDir();
    this.modelSet = config?.modelSet ?? { id: 'voicedesign', dir: defaultDir, files: VOICEDESIGN_MODEL_FILES, manifestDriven: false };
    this.states = this.modelSet.files.map((file) => ({
      file,
      status: ModelStatus.PENDING,
      error: null,
      progress: 0,
      loadStartMs: 0,
      loadEndMs: 0,
    }));
  }

  /** 取回本轮已加载的模型 buffer（供 OrtSessionManager.loadModel 使用） */
  getBuffers(): Map<string, ArrayBuffer> {
    return this.buffers;
  }

  /** 获取所有模型加载状态 */
  getStates(): ModelLoadState[] {
    return this.states;
  }

  /** 获取目录句柄 */
  getDirHandle(): FileSystemDirectoryHandle | null {
    return this.dirHandle;
  }

  /** 设置已有目录句柄（由外部 showDirectoryPicker 获得） */
  setDirHandle(handle: FileSystemDirectoryHandle): void {
    this.dirHandle = handle;
  }

  /** 从已设置的 dirHandle 校验并加载所有模型文件（不弹出选择器） */
  async loadFromExistingHandle(): Promise<ModelLoadResult> {
    this.resetStates();
    this.abortController = new AbortController();
    if (!this.dirHandle) {
      return { success: false, dirHandle: null, states: this.states, needsUserDownload: true,
        errorMessage: '未设置模型目录句柄，请重新选择文件夹。' };
    }
    await this.verifyAllFromDirHandle();
    const allVerified = this.areAllRequiredReady();
    eventBus.emit(AppEvents.MODEL_ALL_COMPLETE, allVerified);
    return {
      success: allVerified,
      dirHandle: allVerified ? this.dirHandle : null,
      states: this.states,
      needsUserDownload: !allVerified,
      buffers: this.buffers,
      errorMessage: allVerified ? undefined : '部分模型文件缺失或校验失败，请重新下载。',
    };
  }

  /** 检查 talker + talker_cache 是否都已 VERIFIED */
  isTalkerPairReady(): boolean {
    const talkerState = this.states.find((s) => s.file.filename === 'talker.onnx');
    const talkerCacheState = this.states.find((s) => s.file.filename === 'talker_cache.onnx');
    // talker_cache is optional (required: false), only check talker
    return talkerState?.status === ModelStatus.VERIFIED;
  }

  /** 检查所有 required 模型是否都已 VERIFIED */
  areAllRequiredReady(): boolean {
    return this.states
      .filter((s) => s.file.required)
      .every((s) => s.status === ModelStatus.VERIFIED);
  }

  // ── Dev 模式加载 ──

  /**
   * Dev 模式：通过 fetch 静态文件服务读取固定目录
   */
  async loadDevModels(): Promise<ModelLoadResult> {
    this.resetStates();
    this.buffers.clear();
    this.abortController = new AbortController();

    const totalFiles = this.modelSet.files.length;
    let loadedCount = 0;

    for (const modelFile of this.modelSet.files) {
      const state = this.states.find((s) => s.file.filename === modelFile.filename);
      if (!state) continue;

      state.status = ModelStatus.LOADING;
      state.loadStartMs = Date.now();
      state.progress = 0;
      this.emitProgress(modelFile.filename, state.status, state.progress);

      try {
        const url = getModelPath(this.modelSet, modelFile.filename);
        const response = await this.fetchWithTimeout(url);

        if (!response.ok) {
          if (modelFile.required) {
            throw new AppError(
              'MODEL_FILE_MISSING',
              `模型文件 ${modelFile.filename} 获取失败: HTTP ${response.status}`,
              { status: response.status }
            );
          } else {
            state.status = ModelStatus.SKIPPED;
            state.loadEndMs = Date.now();
            this.emitProgress(modelFile.filename, state.status, 0);
            continue;
          }
        }

        const buffer = await response.arrayBuffer();
        state.progress = 50;
        this.emitProgress(modelFile.filename, state.status, state.progress);

        // 体积校验
        if (buffer.byteLength !== modelFile.sizeBytes) {
          throw new AppError(
            'SIZE_MISMATCH',
            `${modelFile.filename} 体积不匹配：期望 ${formatFileSize(modelFile.sizeBytes)}，实际 ${formatFileSize(buffer.byteLength)}`,
            { expected: modelFile.sizeBytes, actual: buffer.byteLength }
          );
        }

        // SHA-256 校验（sha256 为空字符串 '' 或 verifySha256===false 时跳过；voiceDesign 集尚未补全实测值）
        const shouldVerify = this.config.enableSha256 && modelFile.verifySha256 !== false && !!modelFile.sha256;
        if (shouldVerify) {
          const actualHash = await Sha256Calculator.computeFromBuffer(buffer);
          state.progress = 80;
          this.emitProgress(modelFile.filename, state.status, state.progress);

          if (actualHash !== modelFile.sha256) {
            throw new AppError(
              'SHA256_MISMATCH',
              `${modelFile.filename} SHA-256 校验失败`,
              { expected: modelFile.sha256, actual: actualHash }
            );
          }
        } else {
          state.progress = 80;
          this.emitProgress(modelFile.filename, state.status, state.progress);
        }

        // 缓存原始 buffer（供 sessionManager 加载）
        this.buffers.set(modelFile.filename, buffer);

        state.status = ModelStatus.VERIFIED;
        state.progress = 100;
        state.loadEndMs = Date.now();
        loadedCount++;

      } catch (err) {
        state.status = ModelStatus.FAILED;
        state.error = err instanceof AppError ? `${err.code}: ${err.message}` : String(err);
        state.loadEndMs = Date.now();
        logger.error(`[ModelLoader] ❌ ${modelFile.filename}:`, err);
      }

      this.emitProgress(modelFile.filename, state.status, state.progress);
    }

    this.abortController = null;

    const allVerified = this.areAllRequiredReady();
    eventBus.emit(AppEvents.MODEL_ALL_COMPLETE, allVerified);

    return {
      success: allVerified,
      dirHandle: null,
      states: this.states,
      needsUserDownload: !allVerified,
      buffers: this.buffers,
      errorMessage: allVerified
        ? undefined
        : '部分模型文件缺失或校验失败，请检查 Models/ 目录。',
    };
  }

  // ── Prod 模式加载 ──

  /**
   * Prod 模式：FSAA 获取目录句柄 → SHA-256 校验
   * 不支持 FSAA 或用户取消时返回 needsUserDownload=true
   */
  async loadProdModels(): Promise<ModelLoadResult> {
    this.resetStates();
    this.abortController = new AbortController();

    // 尝试通过 FSAA 获取目录句柄
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker({
          id: 'qwen3-tts-models',
          mode: 'readonly',
        });
        this.dirHandle = handle as FileSystemDirectoryHandle;
      } catch {
        return {
          success: false,
          dirHandle: null,
          states: this.states,
          needsUserDownload: true,
          errorMessage: '用户取消了目录选择，或未检测到模型文件。请从 HuggingFace 下载并放置到 Models/voicedesign/onnx/ 目录。',
        };
      }
    } else {
      return {
        success: false,
        dirHandle: null,
        states: this.states,
        needsUserDownload: true,
        errorMessage: '请使用 Chrome 91+ 浏览器，或手动通过 <input webkitdirectory> 选择模型目录。',
      };
    }

    // 校验文件
    await this.verifyAllFromDirHandle();

    const allVerified = this.areAllRequiredReady();
    eventBus.emit(AppEvents.MODEL_ALL_COMPLETE, allVerified);

    return {
      success: allVerified,
      dirHandle: allVerified ? this.dirHandle : null,
      states: this.states,
      needsUserDownload: !allVerified,
      buffers: this.buffers,
      errorMessage: allVerified
        ? undefined
        : '部分模型文件缺失或校验失败，请重新下载。',
    };
  }

  /**
   * 从 FSAA 目录句柄验证所有模型文件
   */
  private async verifyAllFromDirHandle(): Promise<void> {
    if (!this.dirHandle) return;

    const files = this.modelSet.files;
    const totalFiles = files.length;
    let loadedCount = 0;

    for (const modelFile of files) {
      const state = this.states.find((s) => s.file.filename === modelFile.filename);
      if (!state) continue;

      state.status = ModelStatus.LOADING;
      state.loadStartMs = Date.now();
      state.progress = 0;
      this.emitProgress(modelFile.filename, state.status, state.progress);

      try {
        let fileHandle: FileSystemFileHandle;
        try {
          fileHandle = await this.dirHandle.getFileHandle(modelFile.filename);
        } catch {
          if (modelFile.required) {
            throw new AppError(
              'MODEL_FILE_MISSING',
              `模型文件 ${modelFile.filename} 缺失`,
              { filename: modelFile.filename }
            );
          } else {
            state.status = ModelStatus.SKIPPED;
            state.loadEndMs = Date.now();
            this.emitProgress(modelFile.filename, state.status, 0);
            continue;
          }
        }

        const file = await fileHandle.getFile();
        state.progress = 30;
        this.emitProgress(modelFile.filename, state.status, state.progress);

        // 体积校验
        if (file.size !== modelFile.sizeBytes) {
          throw new AppError(
            'SIZE_MISMATCH',
            `${modelFile.filename} 体积不匹配：期望 ${formatFileSize(modelFile.sizeBytes)}，实际 ${formatFileSize(file.size)}`,
            { expected: modelFile.sizeBytes, actual: file.size }
          );
        }

        state.progress = 50;
        this.emitProgress(modelFile.filename, state.status, state.progress);

        // SHA-256 校验
        if (this.config.enableSha256) {
          const actualHash = await Sha256Calculator.computeFromFile(file);
          state.progress = 80;
          this.emitProgress(modelFile.filename, state.status, state.progress);

          if (actualHash !== modelFile.sha256) {
            throw new AppError(
              'SHA256_MISMATCH',
              `${modelFile.filename} SHA-256 校验失败`,
              { expected: modelFile.sha256, actual: actualHash }
            );
          }
        }

        state.status = ModelStatus.VERIFIED;
        state.progress = 100;
        state.loadEndMs = Date.now();
        loadedCount++;

      } catch (err) {
        state.status = ModelStatus.FAILED;
        state.error = err instanceof AppError ? `${err.code}: ${err.message}` : String(err);
        state.loadEndMs = Date.now();
        logger.error(`[ModelLoader] ❌ ${modelFile.filename}:`, err);
      }

    this.emitProgress(modelFile.filename, state.status, state.progress);
  }
}

  // ── 公共方法 ──

  /**
   * 一站式校验：计算 SHA-256 并与期望值对比
   */
  async verifyChecksum(file: File, expectedHex: string): Promise<boolean> {
    return Sha256Calculator.verifyFile(file, expectedHex);
  }

  /**
   * 生成下载指引数据
   */
  getDownloadGuide(): DownloadGuideData {
    return buildDownloadGuideData();
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.dirHandle = null;
    this.resetStates();
  }

  // ── 内部辅助 ──

  /** 重置所有状态 */
  private resetStates(): void {
    this.states = this.modelSet.files.map((file) => ({
      file,
      status: ModelStatus.PENDING,
      error: null,
      progress: 0,
      loadStartMs: 0,
      loadEndMs: 0,
    }));
  }

  /** 发送进度事件 */
  private emitProgress(filename: string, status: ModelStatus, progress: number): void {
    this.config.onProgress?.(filename, status, progress);
    eventBus.emit(AppEvents.MODEL_PROGRESS, filename, status, progress);
  }

  /** 带超时的 fetch（每次调用使用独立 AbortController） */
  private async fetchWithTimeout(
    url: string,
    timeoutMs: number = MODEL_LOAD_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // 如果全局中止信号触发，也应中止
      const signal = this.abortController
        ? combineSignals(controller.signal, this.abortController.signal)
        : controller.signal;
      const response = await fetch(url, { signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ── 便捷导出（兼容旧 modelLoader.ts 的 API） ──
// 注：getModelPath / getManifestPath 已迁移至 @/core/modelSet（按 ModelSet 解析相对路径），
//     本文件不再重复导出，统一从 modelSet 引用。

export function getHuggingFaceUrl(): string {
  return HF_MODEL_URL;
}

export function getModelFileList(): ModelFileInfo[] {
  return [...VOICEDESIGN_MODEL_FILES];
}

export function generateDownloadGuide(): DownloadGuideData {
  return buildDownloadGuideData();
}
