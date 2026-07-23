/**
 * src/worker/workerManager.ts — 主线程 Worker 生命周期管理器
 *
 * 负责：
 * - Worker 创建 / 销毁 / 重建
 * - 任务入队（通过 TaskQueue 串行化）
 * - 自动重建检测（任务数≥50 或 内存未回落）
 * - 内存基线追踪
 * - EP（执行提供程序）感知的 Worker 初始化
 */

import { TaskQueue } from '@/worker/taskQueue';
import { WorkerProtocol } from '@/worker/workerProtocol';
import { eventBus, AppEvents } from '@/core/eventBus';
import {
  REBUILD_TASK_COUNT,
  REBUILD_MEMORY_LEAK_CHECK_COUNT,
  MEMORY_LEAK_BASELINE_RATIO,
} from '@/core/constants';
import type { ExecutionProvider, WorkerStatus, WorkerStatusSnapshot } from '@/types';
import { logger } from '@/core/logger';

/**
 * pendingResolves 条目的超时时间 (ms)，按任务类型区分：
 * - load_model：WebGPU 首次需为 int4 模型 JIT 编译 shader + 上传权重，868MB talker 可能 10-20min，给 30min
 * - run_inference：AR 循环单步（非缓存 talker 重跑前缀）可能较慢，给 10min
 * - 其它：60 秒
 */
function pendingTimeoutMs(type: string): number {
  if (type === 'load_model') return 1_800_000;
  if (type === 'run_inference') return 600_000;
  return 60_000;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export class WorkerManager {
  private worker: Worker | null = null;
  private taskQueue: TaskQueue;
  private _taskCounter = 0;
  private _rebuildCount = 0;
  private _status: WorkerStatus = 'idle';
  private _isRebuilding = false;
  private _baselineMemoryMB: number | null = null;
  private _consecutiveLeakCount = 0;
  private _currentTaskType: string = '';
  private pendingResolves: Map<string, PendingEntry> = new Map();

  /** 存储初始化参数，供 rebuild 时复用 */
  private _ortWasmPath: string = '';
  private _executionProvider: ExecutionProvider = 'wasm';

  constructor() {
    this.taskQueue = new TaskQueue();
  }

  get status(): WorkerStatus {
    return this._status;
  }

  get taskCounter(): number {
    return this._taskCounter;
  }

  get isRebuilding(): boolean {
    return this._isRebuilding;
  }

  /** 获取当前执行提供程序 */
  get executionProvider(): ExecutionProvider {
    return this._executionProvider;
  }

  /**
   * 初始化：创建 Worker 并发送 init 消息（含 EP 信息）
   *
   * @param ortWasmPath ONNX Runtime WASM 文件路径
   * @param executionProvider 执行提供程序（'webgpu' | 'wasm'），默认 'wasm'
   */
  async initialize(ortWasmPath: string = '', executionProvider: ExecutionProvider = 'wasm'): Promise<void> {
    this._ortWasmPath = ortWasmPath;
    this._executionProvider = executionProvider;

    return new Promise<void>((resolve, reject) => {
      try {
        // 创建 Worker（Vite 支持直接 import Worker）
        this.worker = new Worker(
          new URL('./ttsWorker.ts', import.meta.url),
          { type: 'module' }
        );

        this.worker.onmessage = (event: MessageEvent) => {
          this.handleWorkerMessage(event.data);
        };

        this.worker.onerror = (err) => {
        logger.error('[WorkerManager] Worker error:', err);
        this._status = 'error';
          eventBus.emit(AppEvents.WORKER_STATUS_CHANGED, this._status);
          // 自动重建，不阻塞 onerror 返回
          this.rebuildWorker('Worker error event').catch(e =>
            logger.error('[WorkerManager] Auto-rebuild failed:', e)
          );
        };

        // 发送 init（含 EP 信息）
        const initMsg = WorkerProtocol.createMessage('init', {
          ortWasmPath,
          executionProvider,
        });
        this.pendingResolves.set(initMsg.taskId, {
          resolve: () => {
            this._status = 'idle';
            eventBus.emit(AppEvents.WORKER_STATUS_CHANGED, this._status);
            resolve();
          },
          reject,
        });

        this.worker.postMessage(initMsg);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 入队任务 */
  async enqueueTask<T = unknown>(
    type: string,
    payload: unknown,
  ): Promise<T> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    if (this._isRebuilding) {
      throw new Error('Worker is rebuilding, please retry');
    }

    const taskId = WorkerProtocol.generateTaskId();

    // 记录当前任务类型（用于 _taskCounter 精准计数）
    this._currentTaskType = type;

    // 如果类型是 run_inference，更新状态
    if (type === 'run_inference') {
      this._status = 'busy';
      eventBus.emit(AppEvents.WORKER_STATUS_CHANGED, this._status);
    }

    return new Promise<T>((resolve, reject) => {
      // 注册 Promise resolve/reject（带超时）
      const entry: PendingEntry = {
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      this.pendingResolves.set(taskId, entry);

      // 超时保护（按任务类型区分时长）
      const timeoutMs = pendingTimeoutMs(type);
      entry.timeoutId = setTimeout(() => {
        if (this.pendingResolves.has(taskId)) {
          const e = this.pendingResolves.get(taskId);
          if (e) {
            e.reject(new Error(`Task ${taskId} (type=${type}) timed out after ${timeoutMs}ms`));
          }
          this.pendingResolves.delete(taskId);
        }
      }, timeoutMs);

      // 入队
      this.taskQueue.enqueue({
        id: taskId,
        type,
        payload,
        priority: 0,
        createdAt: Date.now(),
      }).then(() => {
        // 任务已出队，发送到 Worker
        const msg = WorkerProtocol.createMessage(
          type as 'init' | 'load_model' | 'run_inference' | 'release_model' | 'health_check' | 'shutdown',
          payload as never,
          taskId,
        );

        if (this.worker) {
          const { payload: transferPayload, transfer } = WorkerProtocol.toTransferable(msg);
          if (transfer.length > 0) {
            this.worker.postMessage(transferPayload, transfer);
          } else {
            this.worker.postMessage(transferPayload);
          }
        }
      }).catch(reject);
    });
  }

  /** 获取 Worker 状态快照 */
  getWorkerStatus(): WorkerStatusSnapshot {
    return {
      status: this._status,
      taskCount: this._taskCounter,
      isRebuilding: this._isRebuilding,
      memoryMB: 0, // 需通过 health_check 获取
    };
  }

  /** 重建 Worker（保留原始 EP 和 WASM 路径） */
  async rebuildWorker(reason: string): Promise<void> {
    this._isRebuilding = true;
    eventBus.emit(AppEvents.WORKER_STATUS_CHANGED, 'idle');

    // 等待当前任务完成
    if (this.taskQueue.running) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.taskQueue.running) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    }

    // 清空剩余队列
    this.taskQueue.clear();

    // 关闭旧 Worker
    if (this.worker) {
      const shutdownMsg = WorkerProtocol.createMessage('shutdown', null);
      try {
        this.worker.postMessage(shutdownMsg);
        // 等待 shutdown 完成或超时
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            logger.warn('[WorkerManager] Worker shutdown 超时，强制 terminate');
            resolve();
          }, 5000);

          const handler = (event: MessageEvent) => {
            const data = event.data;
            if (data?.type === 'result' && data?.taskId === shutdownMsg.taskId) {
              clearTimeout(timeout);
              this.worker?.removeEventListener('message', handler);
              resolve();
            }
          };
          this.worker?.addEventListener('message', handler);
        });
      } catch {
        // ignore
      }
      this.worker.terminate();
      this.worker = null;
    }

    // 清理 pending resolves（含超时计时器）
    for (const [id, { reject, timeoutId }] of this.pendingResolves) {
      if (timeoutId) clearTimeout(timeoutId);
      reject(new Error('Worker rebuilt'));
    }
    this.pendingResolves.clear();

    // 重置计数器
    this._taskCounter = 0;
    this._consecutiveLeakCount = 0;
    this._rebuildCount++;

    // 重新初始化（保留原始 EP 和 WASM 路径）
    await this.initialize(this._ortWasmPath, this._executionProvider);

    this._isRebuilding = false;
  }

  /** 记录基线内存 */
  setBaselineMemory(memoryMB: number): void {
    this._baselineMemoryMB = memoryMB;
    this._consecutiveLeakCount = 0;
  }

  /** 检查并触发自动重建 */
  checkAutoRebuild(currentMemoryMB: number): string | null {
    // 条件 1: 任务数达到阈值
    if (this._taskCounter >= REBUILD_TASK_COUNT) {
      return `taskCount(${this._taskCounter})`;
    }

    // 条件 2: 连续 N 次内存未回落
    if (this._baselineMemoryMB !== null) {
      const threshold = this._baselineMemoryMB * (1 + MEMORY_LEAK_BASELINE_RATIO);
      if (currentMemoryMB > threshold) {
        this._consecutiveLeakCount++;
        if (this._consecutiveLeakCount >= REBUILD_MEMORY_LEAK_CHECK_COUNT) {
          return `memoryLeak(baseline=${this._baselineMemoryMB.toFixed(0)}MB, current=${currentMemoryMB.toFixed(0)}MB)`;
        }
      } else {
        this._consecutiveLeakCount = 0;
      }
    }

    return null;
  }

  /** 终止 Worker */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.taskQueue.clear();
    // 清理 pending resolves（含超时计时器）
    for (const [, { reject, timeoutId }] of this.pendingResolves) {
      if (timeoutId) clearTimeout(timeoutId);
      reject(new Error('Worker terminated'));
    }
    this.pendingResolves.clear();
    this._taskCounter = 0;
    this._status = 'idle';
  }

  // ── 私有方法 ──

  private handleWorkerMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const msg = data as Record<string, unknown>;

    if (!WorkerProtocol.validateMessage(data)) return;

    const taskId = msg.taskId as string;
    const pending = this.pendingResolves.get(taskId);

    switch (msg.type) {
      case 'result': {
        if (pending) {
          pending.resolve(msg.payload);
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          this.pendingResolves.delete(taskId);
        }
        // 重置任务队列状态（关键：否则 isRunning 永为 true，后续任务无法出队）
        if (this.taskQueue.running) {
          this.taskQueue.completeTask(msg.payload as unknown);
        }
        // 仅对推理任务计数（重建阈值基于推理任务数）
        if (this._currentTaskType === 'run_inference') {
          this._taskCounter++;
        }
        this._status = 'idle';
        eventBus.emit(AppEvents.WORKER_STATUS_CHANGED, this._status);
        break;
      }
      case 'error': {
        if (pending) {
          const errorPayload = msg.payload as { code?: string; message?: string } | undefined;
          const code = errorPayload?.code ?? 'UNKNOWN';
          const message = errorPayload?.message ?? 'Unknown worker error';
          pending.reject(new Error(`[${code}] ${message}`));
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          this.pendingResolves.delete(taskId);
        }
        // 重置任务队列状态
        if (this.taskQueue.running) {
          this.taskQueue.failTask(new Error((msg.payload as { message?: string })?.message ?? 'Worker error'));
        }
        this._status = 'error';
        eventBus.emit(AppEvents.WORKER_STATUS_CHANGED, this._status);
        break;
      }
      case 'progress': {
        // 进度消息不 resolve Promise，仅记录
        break;
      }
      case 'health_report': {
        if (pending) {
          pending.resolve(msg.payload);
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          this.pendingResolves.delete(taskId);
        }
        break;
      }
    }
  }
}
