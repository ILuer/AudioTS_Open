/**
 * src/core/ortSessionManager.ts — ORT Session 生命周期管理（主线程门面）
 *
 * 通过 WorkerManager 间接管理 Worker 中的 Session。
 * 主线程不持有 ONNX Session 引用——实际 session 在 Worker 内。
 *
 * 构造函数接受 executionProvider 参数，透传 EP 给 Worker。
 *
 * 目标 2（模型路径相对化）扩展：
 * - 构造接受可选的 modelDir（默认 VOICEDESIGN_MODEL_DIR），仅用于日志/路径展示；
 *   真正的模型集隔离由「独立的 WorkerManager + OrtSessionManager 实例」保证
 *   （Base 集与 VoiceDesign 集各自一个实例，同名 session 互不干扰）。
 * - loadModel 现在保存 ONNX 的 inputNames / outputNames，供 AR 循环按名构造多输出。
 * - 支持按需懒加载：runInference 首次调用某模型时自动 loadModel，之后复用 session。
 */

import { WorkerManager } from '@/worker/workerManager';
import type { ExecutionProvider, SessionHandle } from '@/types';
import { VOICEDESIGN_MODEL_DIR } from '@/core/constants';

export class OrtSessionManager {
  private workerManager: WorkerManager;
  private sessionHandles: Map<string, SessionHandle> = new Map();
  private executionProvider: ExecutionProvider;
  /** 该 SessionManager 负责的模型目录（仅用于日志/路径展示，隔离由独立实例保证） */
  private modelDir: string;
  /**
   * 原始模型 buffer（key=文件名带 .onnx），由 App 在模型文件加载完成后注入。
   * runInference 首次调用某模型时，从此处按需 loadModel，之后缓存 session。——按需懒加载机制。
   */
  private buffers: Map<string, ArrayBuffer> | null = null;

  /**
   * 已释放但尚未被 GC 真正回收的字节数。
   * freeMemory() 释放主线程 buffer 时累加，用于显示层面「即时扣除」，
   * 待浏览器 GC 实际回收后再清零，从而回到真实堆占用。
   */
  private pendingFreedBytes = 0;

  /**
   * 释放动作发生前的 JS 堆基线（usedJSHeapSize）。
   * 用于判断 GC 是否已回收（实时值回落到基线减去待回收量以下）。
   */
  private releaseBaselineUsed = 0;

  /**
   * @param workerManager Worker 管理器实例（需已 initialize 完成）
   * @param executionProvider 执行提供程序（'webgpu' | 'wasm'），默认 'wasm'
   * @param modelDir 模型目录（相对路径），默认 VOICEDESIGN_MODEL_DIR
   */
  constructor(
    workerManager: WorkerManager,
    executionProvider: ExecutionProvider = 'wasm',
    modelDir: string = VOICEDESIGN_MODEL_DIR,
  ) {
    this.workerManager = workerManager;
    this.executionProvider = executionProvider;
    this.modelDir = modelDir;
  }

  /** 获取当前执行提供程序 */
  get currentEP(): ExecutionProvider {
    return this.executionProvider;
  }

  /** 获取该 SessionManager 负责的模型目录（相对路径） */
  get dir(): string {
    return this.modelDir;
  }

  /**
   * 注入模型 buffer（key=文件名带 .onnx），供 runInference 按需惰性加载。
   * 由 App 在 ModelLoader 完成后调用。
   */
  setBuffers(buffers: Map<string, ArrayBuffer>): void {
    // 新模型加载后，旧的「待回收」计数失效，避免错误扣除最新堆占用
    this.pendingFreedBytes = 0;
    // Clone all buffers — postMessage transfer destroys the originals.
    // The clone stays intact for re-synthesis after model release.
    this.buffers = new Map();
    for (const [key, buf] of buffers) {
      this.buffers.set(key, buf.slice(0));
    }
  }

  /** 模型文件是否已加载 */
  get buffersReady(): boolean {
    return this.buffers !== null && this.buffers.size > 0;
  }

  /** 已加载的模型数量 */
  get bufferCount(): number {
    return this.buffers?.size ?? 0;
  }

  /** 加载模型 */
  async loadModel(modelName: string, buffer: ArrayBuffer): Promise<SessionHandle> {
    const result = await this.workerManager.enqueueTask<{
      modelName: string;
      status: string;
      inputNames: string[];
      outputNames: string[];
    }>('load_model', { modelName, buffer: buffer.slice(0) });

    const handle: SessionHandle = {
      modelName: result.modelName,
      modelPath: modelName,
      isLoaded: true,
      memoryEstimateMB: Math.round(buffer.byteLength / (1024 * 1024)),
      inputNames: result.inputNames ?? [],
      outputNames: result.outputNames ?? [],
    };

    this.sessionHandles.set(modelName, handle);

    // Free the redundant main-thread buffer copy now that ORT owns the weights in its session.
    // Keeping each model in EITHER this.buffers OR a session (never both) eliminates the 2x heap
    // inflation that made a 2.7GB model report as ~5.4GB and triggered false memory degradation.
    if (this.buffers) this.buffers.delete(`${modelName}.onnx`);

    return handle;
  }

  /** 获取已加载的 Session 句柄 */
  getSession(modelName: string): SessionHandle | null {
    return this.sessionHandles.get(modelName) ?? null;
  }

  /**
   * 确保模型已加载（惰性加载）。
   * 改进依据: BugFix — KV-cache initMetadata 需要先加载模型才能读取 ONNX input/output 名称
   */
  async ensureModelLoaded(modelName: string): Promise<SessionHandle> {
    const existing = this.sessionHandles.get(modelName);
    if (existing?.isLoaded) return existing;
    if (!this.buffers) {
      throw new Error(`[SessionManager] buffers not set — cannot load ${modelName}`);
    }
    const buf = this.buffers.get(`${modelName}.onnx`);
    if (!buf) {
      throw new Error(`[SessionManager] buffer not found for model ${modelName}`);
    }
    return this.loadModel(modelName, buf);
  }

  /** 运行推理（含按需惰性加载：首次调用自动 loadModel，之后复用缓存的 session） */
  async runInference<T = unknown>(
    modelName: string,
    inputs: Record<string, unknown>,
    shapes?: Record<string, number[]>,
    inferenceType?: string,
  ): Promise<T> {
    const handle = this.sessionHandles.get(modelName);
    if (!handle || !handle.isLoaded) {
      // 惰性加载：从 buffers 里找对应 buffer（key 为文件名带 .onnx）
      if (!this.buffers) {
        throw new Error(`[SessionManager] buffers not set — cannot lazy-load ${modelName}`);
      }
      const buf = this.buffers.get(`${modelName}.onnx`);
      if (!buf) {
        throw new Error(`[SessionManager] buffer not found for model ${modelName}`);
      }
      await this.loadModel(modelName, buf);
    }

    // Per-inference logging handled by Worker summary — avoid 8500+ lines of spam

    const result = await this.workerManager.enqueueTask<T>('run_inference', {
      modelName,
      inputs,
      shapes,
      inferenceType,
    });

    return result;
  }

  /**
   * 释放单个模型：仅移除 Worker 内的推理 session 与主线程句柄。
   * 注意：自 loadModel 加载后主线程 buffer 副本已被删除（消除 2x 堆翻倍），
   * 此处不再保留 buffer。释放后若需再次合成，须重新 setBuffers 加载模型。
   */
  async releaseModel(modelName: string): Promise<void> {
    await this.workerManager.enqueueTask('release_model', { modelName });
    this.sessionHandles.delete(modelName);
  }

  /**
   * 释放所有已加载的模型 session（Worker 内），并清空主线程缓存的模型 buffer，
   * 彻底回收 JS 堆内存。释放后如需再合成，需重新选择模型目录（setBuffers）。
   */
  async releaseAll(): Promise<void> {
    await Promise.all(Array.from(this.sessionHandles.keys()).map(name => this.releaseModel(name)));
    this.sessionHandles.clear();
    this.freeBuffers();
  }

  /**
   * 仅释放主线程缓存的模型 buffer（ArrayBuffer），使其脱离引用、可被 GC 回收。
   * 不触碰 Worker 内 session —— 用于「保留已加载 session、仅回收原始模型数据」的场景。
   */
  freeBuffers(): void {
    let freed = 0;
    if (this.buffers) {
      for (const buf of this.buffers.values()) freed += buf.byteLength;
    }
    this.pendingFreedBytes = freed;
    this.buffers = null;
  }

  /**
   * 统一手动释放入口：释放 Worker session + 主线程 buffer，彻底回收 JS 堆内存。
   * 释放后 buffersReady 变为 false，状态栏应提示用户重新选择模型目录方可再次合成。
   */
  async freeMemory(): Promise<void> {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.releaseBaselineUsed = mem?.usedJSHeapSize ?? 0;
    // ORT session 占用的真实字节数（= 模型权重，稳态下 this.buffers 已为空，必须按此扣减）
    const ortFootprintBytes = this.getMemoryEstimate() * 1024 * 1024;
    await this.releaseAll();
    // releaseAll 内的 freeBuffers 已按残留 this.buffers 设置 pendingFreedBytes（稳态下≈0），
    // 这里补上刚释放的 ORT session 占用，使状态栏在点击瞬间即下降。
    this.pendingFreedBytes += ortFootprintBytes;
  }

  /**
   * 显示用 JS 堆占用（字节）= 实时 usedJSHeapSize 减去「已释放但尚未被 GC 回收」的字节。
   * 释放点击后立刻可见下降；待 GC 真正回收后自动清零 pendingFreedBytes，回到真实值。
   */
  getDisplayUsedBytes(): number {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const live = mem?.usedJSHeapSize ?? 0;
    if (!live) {
      this.pendingFreedBytes = 0;
      return 0;
    }
    // GC 已回收（实时值已低于基线减去待回收量）→ 清零，避免重复扣除
    if (this.pendingFreedBytes > 0 && live <= this.releaseBaselineUsed - this.pendingFreedBytes + 1) {
      this.pendingFreedBytes = 0;
    }
    return Math.max(0, live - this.pendingFreedBytes);
  }

  /** 获取已加载模型名列表 */
  getLoadedModels(): string[] {
    return Array.from(this.sessionHandles.keys());
  }

  /** 获取总内存估算 (MB) */
  getMemoryEstimate(): number {
    let total = 0;
    for (const handle of this.sessionHandles.values()) {
      total += handle.memoryEstimateMB;
    }
    return total;
  }
}
