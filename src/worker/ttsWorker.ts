/**
 * src/worker/ttsWorker.ts — Web Worker 入口
 *
 * 在 Worker 线程中运行 ONNX Runtime Web 推理（支持 WebGPU / WASM 双 EP）。
 * 维护内部 Map<string, InferenceSession> 存储已加载模型。
 *
 * 消息处理：
 *   init          → 根据 executionProvider 条件导入 ORT（webgpu 或 wasm）
 *   load_model    → 从 ArrayBuffer 创建 InferenceSession（使用当前 EP + wasm fallback）
 *   run_inference → 执行推理（WebGPU 模式使用 gpu-buffer 输出零拷贝）
 *   release_model → 释放单个 session
 *   health_check  → 返回健康状态（含 EP 和已加载模型列表）
 *   shutdown      → 释放所有 session + self.close()
 */

/**
 * TTS Web Worker 入口
 * ===================
 * 改进依据: 反思报告 P2-2 — Worker 调试日志不可见，需桥接到主线程
 * 
 * 日志桥接设计（未来实现）:
 *   统一经 @/core/logger 输出（interactive / warn / error 三类语义），
 *   不再在 Worker 内直接使用 console.*：
 *   ```
 *   logger.warn(...); logger.error(...);
 *   ```
 *   主线程通过 WorkerManager 接收结果，统一展示在开发者日志面板或浏览器控制台。
 * 
 * 当前状态: 已接入 logger（warn / error），过程日志已全部移除。
 * 迁移计划: 在 workerProtocol.ts 中增加 'log' 消息类型后进一步桥接到主线程面板
 */

import { logger } from '@/core/logger';

// ONNX Runtime Web 在 Worker 中通过动态 import 加载
// 根据 init 消息中的 executionProvider 决定导入 webgpu 或 wasm 入口
let ort: typeof import('onnxruntime-web') | null = null;

/** 当前 Worker 使用的执行提供程序 */
let currentEP: string = 'wasm';

/** 已加载的模型 session 映射 */
const sessions: Map<string, import('onnxruntime-web').InferenceSession> = new Map();

/** 累计任务数 */
let taskCount = 0;

/**
 * 选择 WASM 线程数：crossOriginIsolated（COOP/COEP 已生效）时启用多线程，
 * 否则单线程。多线程对 1.7B int4 模型推理有数倍加速。
 */
function pickNumThreads(): number {
  try {
    const isolated = typeof self !== 'undefined' && (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    if (!isolated) {
      logger.warn('[TtsWorker] crossOriginIsolated=false，WASM 单线程');
      return 1;
    }
    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.min(Math.max(hw, 2), 8);
    return n;
  } catch {
    return 1;
  }
}

// ── Worker 消息处理 ──

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') {
    self.postMessage({
      type: 'error',
      taskId: 'unknown',
      payload: { code: 'INVALID_MESSAGE', message: 'Invalid message format' },
    });
    return;
  }

  const { type, taskId } = msg;

  try {
    switch (type) {
      case 'init':
        await handleInit(taskId, msg.payload);
        break;
      case 'load_model':
        await handleLoadModel(taskId, msg.payload);
        break;
      case 'run_inference':
        await handleRunInference(taskId, msg.payload);
        break;
      case 'release_model':
        await handleReleaseModel(taskId, msg.payload);
        break;
      case 'health_check':
        handleHealthCheck(taskId);
        break;
      case 'shutdown':
        await handleShutdown(taskId);
        break;
      default:
        self.postMessage({
          type: 'error',
          taskId,
          payload: { code: 'UNKNOWN_TYPE', message: `Unknown message type: ${type}` },
        });
    }
  } catch (err) {
    logger.error(`[TtsWorker] Error handling ${type}:`, err);
    self.postMessage({
      type: 'error',
      taskId,
      payload: {
        code: 'WORKER_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
};

// ── 消息处理函数 ──

/**
 * 初始化 ORT 环境
 * 根据 executionProvider 条件导入 webgpu 或 wasm 入口。
 */
async function handleInit(
  taskId: string,
  payload: { ortWasmPath: string; executionProvider?: string },
): Promise<void> {
  const ep = payload.executionProvider || 'wasm';
  currentEP = ep;

  try {
    // 条件导入：WebGPU 入口 vs 标准 WASM 入口
    if (ep === 'webgpu') {
      ort = await import('onnxruntime-web/webgpu');
    } else {
      ort = await import('onnxruntime-web');
    }

    // 设置 WASM 路径（WebGPU 和 WASM 后端都可能用到）
    if (payload.ortWasmPath) {
      ort.env.wasm.wasmPaths = payload.ortWasmPath;
    }

    // 单线程以避免 Worker 内竞争
    ort.env.wasm.numThreads = pickNumThreads();
    // 抑制 ORT 冗余日志（生产环境推荐 'error' 级别）
    ort.env.logLevel = 'error';

    self.postMessage({
      type: 'result',
      taskId,
      payload: {
        status: 'initialized',
        numThreads: ort.env.wasm.numThreads,
        executionProvider: currentEP,
      },
    });
  } catch (err) {
    // WebGPU 初始化失败时尝试回退到 WASM
    if (currentEP === 'webgpu') {
      logger.warn('[TtsWorker] WebGPU 初始化失败，尝试回退 WASM...', err);
      try {
        currentEP = 'wasm';
        ort = await import('onnxruntime-web');
        if (payload.ortWasmPath) {
          ort.env.wasm.wasmPaths = payload.ortWasmPath;
        }
        ort.env.wasm.numThreads = pickNumThreads();
        // 抑制 ORT 冗余日志（生产环境推荐 'error' 级别）
        ort.env.logLevel = 'error';

        self.postMessage({
          type: 'result',
          taskId,
          payload: {
            status: 'initialized',
            numThreads: ort.env.wasm.numThreads,
            executionProvider: currentEP,
            fallbackReason: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      } catch (fallbackErr) {
        logger.error('[TtsWorker] WASM 回退也失败了:', fallbackErr);
      }
    }

    logger.error('[TtsWorker] ORT 初始化失败:', err);
    self.postMessage({
      type: 'error',
      taskId,
      payload: {
        code: 'ORT_INIT_FAILED',
        message: err instanceof Error ? err.message : 'Failed to initialize ONNX Runtime',
      },
    });
  }
}

// ── ORT Session 创建辅助 ──
// 按 EP 类型选择不同选项：WASM 用 graphOptimizationLevel + mem arena/pattern（仅 WASM 后端有效）。
// logSeverityLevel: 3（error only）是 ORT 官方生产环境推荐，对 WebGPU/WASM 均生效。
// enableGraphCapture 未启用：AR 循环每步 seqLen 变化，无稳定图可缓存；
//   且启用时要求外部 GPU buffer 管理，对本项目无收益反而增加复杂度。

function createSession(buffer: ArrayBuffer): Promise<import('onnxruntime-web').InferenceSession> {
  if (!ort) throw new Error('ORT not initialized');
  const isWebGpu = currentEP === 'webgpu';
  return ort.InferenceSession.create(buffer, isWebGpu
    ? {
        executionProviders: ['webgpu'],
        logSeverityLevel: 3,
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
        enableMemPattern: true,
        // Default 'cpu' output location — we need cpu-side tensors for
        // postMessage transfer. gpu-buffer would require async getData().
      } as import('onnxruntime-web').InferenceSession.SessionOptions
    : { executionProviders: ['wasm'], logSeverityLevel: 3, graphOptimizationLevel: 'all', enableCpuMemArena: true, enableMemPattern: true }
  );
}

async function handleLoadModel(
  taskId: string,
  payload: { modelName: string; buffer: ArrayBuffer },
): Promise<void> {
  if (!ort) {
    self.postMessage({
      type: 'error',
      taskId,
      payload: { code: 'NOT_INITIALIZED', message: 'ORT not initialized. Send init first.' },
    });
    return;
  }

  const { modelName, buffer } = payload;
  const loadStart = performance.now();

  self.postMessage({
    type: 'progress',
    taskId,
    payload: { stage: 'creating_session', percent: 30 },
  });

  try {
    const session = await createSession(buffer);
    sessions.set(modelName, session);

    self.postMessage({ type: 'progress', taskId, payload: { stage: 'session_ready', percent: 100 } });
    self.postMessage({ type: 'result', taskId, payload: { modelName, status: 'loaded', inputNames: session.inputNames, outputNames: session.outputNames } });

    // 改进依据: BugFix — 记录 KV-cache 所需的真实 ONNX 输入/输出名称
  } catch (err) {
    if (currentEP === 'webgpu') {
      logger.warn(`[TtsWorker] WebGPU session 创建失败，尝试 WASM 回退: ${modelName}`, err);
      try {
        currentEP = 'wasm';
        const session = await createSession(buffer);

        sessions.set(modelName, session);
        self.postMessage({ type: 'progress', taskId, payload: { stage: 'session_ready', percent: 100 } });
        self.postMessage({ type: 'result', taskId, payload: { modelName, status: 'loaded', inputNames: session.inputNames, outputNames: session.outputNames } });

        return;
      } catch (fallbackErr) {
        logger.error(`[TtsWorker] WASM 回退也失败: ${modelName}`, fallbackErr);
      }
    }

    throw err;
  }
}

async function handleRunInference(
  taskId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!ort) {
    self.postMessage({
      type: 'error',
      taskId,
      payload: { code: 'NOT_INITIALIZED', message: 'ORT not initialized.' },
    });
    return;
  }

  // 窄化为非 null 局部常量，避免 async 上下文 TS 控制流失活
  const ortRef = ort;

  taskCount++;
  const modelName = payload.modelName as string;
  const inputs = payload.inputs as Record<string, unknown>;
  const inferenceType = (payload.inferenceType as string) || 'unknown';

  // Per-inference log — only key models to avoid 8500+ lines of spam

  const session = sessions.get(modelName);
  if (!session) {
    self.postMessage({
      type: 'error',
      taskId,
      payload: { code: 'MODEL_NOT_LOADED', message: `Model ${modelName} not loaded` },
    });
    return;
  }

  self.postMessage({
    type: 'progress',
    taskId,
    payload: { stage: 'running_inference', percent: 10 },
  });

  const startTime = performance.now();

  try {
    // 构建 ORT 输入张量
    const Tensor = ortRef.Tensor;
    const feeds: Record<string, InstanceType<typeof Tensor>> = {};
    for (const [key, value] of Object.entries(inputs)) {
      const rawShapes = (payload.shapes as Record<string, number[]>);
      const shapeForKey = rawShapes?.[key];
      if (value instanceof Float32Array) {
        feeds[key] = new Tensor('float32', value, shapeForKey ?? [value.length]);
      } else if (value instanceof BigInt64Array) {
        feeds[key] = new Tensor('int64', new BigInt64Array(value), shapeForKey ?? [value.length]);
      } else if (value instanceof Int32Array) {
        // 当前模型集所有整数输入均为 int64（见 user_script.py io_config）；
        // 主线程传 Int32Array 仅因 TS 端更便捷，Worker 负责转为 int64 Tensor。
        const bi64 = new BigInt64Array(value.length);
        for (let i = 0; i < value.length; i++) bi64[i] = BigInt(value[i]);
        feeds[key] = new Tensor('int64', bi64, shapeForKey ?? [bi64.length]);
      }
    }

    // WebGPU 模式下使用 gpu-buffer 输出以实现零拷贝
    const runOptions: Record<string, unknown> = {};
    if (currentEP === 'webgpu') {
      runOptions.preferredOutputLocation = 'gpu-buffer';
    }

    const results = await session.run(feeds, runOptions);

    self.postMessage({
      type: 'progress',
      taskId,
      payload: { stage: 'processing_results', percent: 80 },
    });

    // 提取输出
    const outputData: Record<string, ArrayBuffer> = {};
    for (const [key, tensor] of Object.entries(results)) {
      const data = tensor.data;
      if (data instanceof Float32Array || data instanceof Int32Array || data instanceof BigInt64Array) {
        // WebGPU gpu-buffer 模式下 data.buffer 可能不是标准 ArrayBuffer，
        // .slice() 可能抛出 TypeError（如 detached buffer），因此防御性检查。
        try {
          if (data.buffer instanceof ArrayBuffer) {
            const ab = data.buffer;
            outputData[key] = ab.slice(data.byteOffset, data.byteOffset + data.byteLength);
          } else {
            // 非标准 buffer（如 WebGPU gpu-buffer / SharedArrayBuffer），手动拷贝数据
            outputData[key] = new Uint8Array(
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            ).buffer;
          }
        } catch {
          // .slice() 或构造函数抛出异常时，回退到逐元素拷贝
          const copy = new Uint8Array(data.byteLength);
          copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          outputData[key] = copy.buffer;
        }
      }
    }

    const durationMs = performance.now() - startTime;

    // Dispose ORT tensors 防止 GPU 显存泄漏
    for (const tensor of Object.values(feeds)) {
      tensor.dispose();
    }
    for (const tensor of Object.values(results)) {
      tensor.dispose();
    }

    const resultMsg = {
      type: 'result',
      taskId,
      payload: {
        success: true,
        data: outputData,
        durationMs,
        taskCount,
      },
    };

    // Transferable: 零拷贝传输各 buffer 到主线程
    const buffers: Transferable[] = Object.values(outputData).filter(
      (b): b is ArrayBuffer => b instanceof ArrayBuffer
    );
    (self.postMessage as (msg: unknown, transfer: Transferable[]) => void)(resultMsg, buffers);

  } catch (err) {
    const durationMs = performance.now() - startTime;
    logger.error(`[TtsWorker] 推理失败 (EP: ${currentEP}):`, err);
    self.postMessage({
      type: 'error',
      taskId,
      payload: {
        code: 'ORT_INFERENCE_FAILED',
        message: err instanceof Error ? err.message : 'Inference failed',
      },
    });
  }
}

async function handleReleaseModel(
  taskId: string,
  payload: { modelName: string },
): Promise<void> {
  const { modelName } = payload;

  const session = sessions.get(modelName);
  if (session) {
    try {
      await session.release();
    } catch (err) {
      logger.warn(`[TtsWorker] Session.release() 失败: ${modelName}`, err);
    }
    sessions.delete(modelName);
  }

  self.postMessage({
    type: 'result',
    taskId,
    payload: { modelName, status: 'released' },
  });
}

function handleHealthCheck(taskId: string): void {
  self.postMessage({
    type: 'health_report',
    taskId,
    payload: {
      taskCount,
      loadedModels: Array.from(sessions.keys()),
      executionProvider: currentEP,
    },
  });
}

async function handleShutdown(taskId: string): Promise<void> {
  // 并行释放所有 session（ORT 官方推荐 Promise.all 提升释放效率）
  await Promise.all(Array.from(sessions).map(async ([name, session]) => {
    try {
      await session.release();
    } catch (err) {
      logger.warn(`[TtsWorker] 释放失败: ${name}`, err);
    }
  }));
  sessions.clear();

  self.postMessage({
    type: 'result',
    taskId,
    payload: { status: 'shutdown_complete', taskCount },
  });

  // 关闭 Worker
  self.close();
}

// ── 辅助 ──
