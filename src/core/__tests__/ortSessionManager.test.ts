/**
 * src/__tests__/ortSessionManager.test.ts — 手动释放（freeMemory / releaseAll / freeBuffers）回归测试
 *
 * 验证：释放后 Worker session 被请求释放、主线程模型 buffer 被清空（JS 堆可回收）。
 * workerManager 用最小 mock（仅 enqueueTask），不启动真实 Worker。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrtSessionManager } from '../ortSessionManager';
import type { WorkerManager } from '../../worker/workerManager';

/** 最小 workerManager mock */
function makeWorkerManager() {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const enqueueTask = vi.fn(async (type: string, payload?: unknown) => {
    calls.push({ type, payload });
    if (type === 'load_model') {
      return {
        modelName: (payload as { modelName: string }).modelName,
        status: 'loaded',
        inputNames: ['input'],
        outputNames: ['output'],
      };
    }
    return { status: 'ok' };
  });
  const wm = { enqueueTask } as unknown as WorkerManager;
  return { wm, enqueueTask, calls };
}

describe('OrtSessionManager 手动释放', () => {
  let sm: OrtSessionManager;
  let enqueueTask: ReturnType<typeof vi.fn>;
  let calls: Array<{ type: string; payload: unknown }>;

  beforeEach(() => {
    const m = makeWorkerManager();
    sm = new OrtSessionManager(m.wm, 'wasm');
    enqueueTask = m.enqueueTask;
    calls = m.calls;
  });

  it('setBuffers 后 buffersReady 为 true，bufferCount 正确', () => {
    sm.setBuffers(new Map([['talker.onnx', new ArrayBuffer(1024)]]));
    expect(sm.buffersReady).toBe(true);
    expect(sm.bufferCount).toBe(1);
  });

  it('loadModel 后释放单个模型 → worker 收到 release_model', async () => {
    sm.setBuffers(new Map([['talker.onnx', new ArrayBuffer(1024)]]));
    await sm.loadModel('talker', new ArrayBuffer(1024));
    expect(sm.getLoadedModels()).toContain('talker');

    // 修复后：loadModel 成功后即移除主线程 buffer 副本（避免双重持有导致堆翻倍），
    // 因此 buffersReady 在 loadModel 后即为 false。
    expect(sm.buffersReady).toBe(false);

    await sm.releaseModel('talker');
    const released = calls.find((c) => c.type === 'release_model');
    expect(released).toBeDefined();
    expect((released!.payload as { modelName: string }).modelName).toBe('talker');
  });

  it('releaseAll 彻底释放：worker 释放所有 session + 主线程 buffer 清空', async () => {
    sm.setBuffers(
      new Map([
        ['talker.onnx', new ArrayBuffer(1024)],
        ['tok_decoder.onnx', new ArrayBuffer(2048)],
      ]),
    );
    await sm.loadModel('talker', new ArrayBuffer(1024));
    await sm.loadModel('tok_decoder', new ArrayBuffer(2048));

    await sm.releaseAll();

    const released = calls.filter((c) => c.type === 'release_model');
    expect(released).toHaveLength(2);
    expect(sm.getLoadedModels()).toHaveLength(0);
    // 关键：主线程 buffer 被清空 → JS 堆可回收
    expect(sm.buffersReady).toBe(false);
    expect(sm.bufferCount).toBe(0);
  });

  it('freeMemory 等价于 releaseAll（彻底回收）', async () => {
    sm.setBuffers(new Map([['talker.onnx', new ArrayBuffer(1024)]]));
    await sm.loadModel('talker', new ArrayBuffer(1024));

    await sm.freeMemory();

    expect(calls.some((c) => c.type === 'release_model')).toBe(true);
    expect(sm.buffersReady).toBe(false);
  });

  it('freeBuffers 仅清空主线程 buffer，不触碰 worker session', async () => {
    sm.setBuffers(new Map([['talker.onnx', new ArrayBuffer(1024)]]));
    await sm.loadModel('talker', new ArrayBuffer(1024));

    sm.freeBuffers();

    expect(sm.buffersReady).toBe(false);
    // 句柄仍在（worker session 未释放）
    expect(sm.getLoadedModels()).toContain('talker');
  });
});

/**
 * getDisplayUsedBytes() 显示用堆占用自纠正测试
 * --------------------------------------------
 * 模拟 Chrome performance.memory API，验证：
 *  - 释放前返回真实 live 值
 *  - 释放后「即时」下降（减去待回收字节，不等 GC）
 *  - GC 回收后自动清零 pendingFreedBytes，回到真实值
 *  - 重新 setBuffers 加载模型后 pendingFreedBytes 清零
 */
describe('OrtSessionManager.getDisplayUsedBytes 显示用堆占用自纠正', () => {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const LIMIT = 4 * GB;
  // 模拟释放前 live ≈ 3000MB（注意：1GB = 1024MB，非 1000MB）
  const BASE = 3000 * MB;

  /** 写入 Chrome 风格 performance.memory（测试环境默认不存在） */
  function setMemory(used: number, limit = LIMIT, total = 3 * GB): void {
    Object.defineProperty(performance, 'memory', {
      value: { jsHeapSizeLimit: limit, totalJSHeapSize: total, usedJSHeapSize: used },
      configurable: true,
    });
  }

  let sm: OrtSessionManager;

  beforeEach(() => {
    const m = makeWorkerManager();
    sm = new OrtSessionManager(m.wm, 'wasm');
    // 默认模拟一个高占用现场：~3000MB
    setMemory(BASE);
  });

  it('用例1：释放前 getDisplayUsedBytes 返回当前 live 值（3000MB）', () => {
    expect(sm.getDisplayUsedBytes()).toBe(BASE);
  });

  it('用例2：注入 1GB buffer 后 freeMemory，显示占用即时下降 1GB', async () => {
    sm.setBuffers(new Map([['a.onnx', new ArrayBuffer(GB)]]));
    // 释放前真实 live 仍为 BASE
    expect(sm.getDisplayUsedBytes()).toBe(BASE);

    await sm.freeMemory();
    expect(sm.buffersReady).toBe(false);

    // 释放后无需等待 GC，显示立即下降 1GB → 1976MB
    expect(sm.getDisplayUsedBytes()).toBe(BASE - GB);
  });

  it('用例3：模拟 GC 回收后，返回值回到真实 live 且 pendingFreedBytes 已清零', async () => {
    sm.setBuffers(new Map([['a.onnx', new ArrayBuffer(GB)]]));
    await sm.freeMemory();
    expect(sm.getDisplayUsedBytes()).toBe(BASE - GB);

    // 模拟浏览器 GC 回收：live 回落到 基线(3000MB) - 1GB = 1976MB
    setMemory(BASE - GB);
    expect(sm.getDisplayUsedBytes()).toBe(BASE - GB);

    // 若 pendingFreedBytes 未清零，live 提升到 2100MB 应仍被再扣 1GB 得 1076MB；
    // 已清零则随 live 线性变化（返回 2100MB）。
    setMemory(2100 * MB);
    expect(sm.getDisplayUsedBytes()).toBe(2100 * MB);
  });

  it('用例4：setBuffers 重新加载模型后 pendingFreedBytes 清零，不再扣除', async () => {
    sm.setBuffers(new Map([['a.onnx', new ArrayBuffer(GB)]]));
    await sm.freeMemory();
    expect(sm.getDisplayUsedBytes()).toBe(BASE - GB);

    // 重新加载模型：旧的「待回收」计数应失效
    sm.setBuffers(new Map([['b.onnx', new ArrayBuffer(512 * MB)]]));
    // 不应再扣除之前的 1GB，返回真实 live（当前 live 仍约 3000MB）
    expect(sm.getDisplayUsedBytes()).toBe(BASE);
  });
});

/**
 * 回归测试：BugFix — 消除模型 buffer 双重持有导致堆翻倍
 * ------------------------------------------------------
 * 验证：
 *  - loadModel 后将主线程 buffer 副本移除（仅 ORT session 持有权重），堆不再翻倍
 *  - freeMemory 按 ORT session 实际占用（getMemoryEstimate）即时扣减显示占用
 */
describe('OrtSessionManager BugFix — 消除双重持有 + freeMemory 按 ORT 占用扣减', () => {
  const MB = 1024 * 1024;
  const GB = 1024 * 1024 * 1024;
  const LIMIT = 4 * GB;
  // 模拟稳定高占用现场：~3000MB
  const BASE = 3000 * MB;

  /** 写入 Chrome 风格 performance.memory（测试环境默认不存在） */
  function setMemory(used: number): void {
    Object.defineProperty(performance, 'memory', {
      value: { jsHeapSizeLimit: LIMIT, totalJSHeapSize: 3 * GB, usedJSHeapSize: used },
      configurable: true,
    });
  }

  let sm: OrtSessionManager;
  let calls: Array<{ type: string; payload: unknown }>;

  beforeEach(() => {
    const m = makeWorkerManager();
    sm = new OrtSessionManager(m.wm, 'wasm');
    calls = m.calls;
    // 模拟稳定高占用现场
    setMemory(BASE);
  });

  it('用例5：loadModel 后主线程 buffer 副本被移除，内存不再翻倍', async () => {
    sm.setBuffers(new Map([['talker.onnx', new ArrayBuffer(100 * MB)]]));
    expect(sm.buffersReady).toBe(true);
    expect((sm as unknown as { buffers: Map<string, ArrayBuffer> }).buffers.size).toBe(1);

    const buf = (sm as unknown as { buffers: Map<string, ArrayBuffer> }).buffers.get('talker.onnx')!;
    await sm.loadModel('talker', buf);

    // 已加载进 ORT session（权重真实存在处）
    expect(sm.getSession('talker')).not.toBeNull();
    // 主线程副本已被删除 —— 不再双重持有（消除 2x 堆翻倍）
    expect((sm as unknown as { buffers: Map<string, ArrayBuffer> }).buffers.get('talker.onnx')).toBeUndefined();
    expect((sm as unknown as { buffers: Map<string, ArrayBuffer> }).buffers.size).toBe(0);
    // session 占用反映 100MB（仅此一处持有权重）
    expect(sm.getMemoryEstimate()).toBe(100);
  });

  it('用例6：freeMemory 按 ORT 占用即时扣减显示', async () => {
    sm.setBuffers(new Map([['talker.onnx', new ArrayBuffer(100 * MB)]]));
    const buf = (sm as unknown as { buffers: Map<string, ArrayBuffer> }).buffers.get('talker.onnx')!;
    await sm.loadModel('talker', buf);
    expect((sm as unknown as { buffers: Map<string, ArrayBuffer> }).buffers.size).toBe(0);

    // 释放前显示真实 live（3000MB）
    expect(sm.getDisplayUsedBytes()).toBe(BASE);

    await sm.freeMemory();

    // ORT 占用的 100MB 立即计入待回收，释放瞬间显示即下降
    expect((sm as unknown as { pendingFreedBytes: number }).pendingFreedBytes).toBe(100 * MB);
    expect(sm.getDisplayUsedBytes()).toBe(BASE - 100 * MB);
    // worker session 已请求释放
    expect(calls.some((c) => c.type === 'release_model')).toBe(true);
  });
});
