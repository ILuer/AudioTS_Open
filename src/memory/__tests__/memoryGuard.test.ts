/**
 * src/memory/__tests__/memoryGuard.test.ts — MemoryGuard 降级/恢复逻辑单测
 *
 * 验证 check() 必须连续 DEGRADE_TRIGGER_COUNT(=2) 次达到严重阈值才降级，
 * 且连续 DEGRADE_RECOVERY_COUNT(=2) 次正常才恢复（触发与恢复对称）。
 * 瞬时严重尖峰（其后回落）不应误伤降级。
 *
 * check() 为 private 方法，测试通过 (guard as any).check() 直接驱动；
 * 通过 Object.defineProperty(performance, 'memory', ...) 注入受控的 Chrome 内存快照。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MemoryGuard } from '@/memory/memoryGuard';
import { DEGRADE_TRIGGER_COUNT, DEGRADE_RECOVERY_COUNT } from '@/core/constants';

const GB = 1024 * 1024 * 1024;
const LIMIT = 4 * GB; // 已知 jsHeapSizeLimit = 4GB

/** 写入受控的 Chrome 内存快照（按占用比例注入 usedJSHeapSize） */
function setMemory(usedRatio: number): void {
  Object.defineProperty(performance, 'memory', {
    value: {
      jsHeapSizeLimit: LIMIT,
      totalJSHeapSize: LIMIT * 0.5,
      usedJSHeapSize: LIMIT * usedRatio,
    },
    configurable: true,
  });
}

/** 驱动一次私有 check() */
function check(guard: MemoryGuard): void {
  (guard as unknown as { check: () => void }).check();
}

describe('MemoryGuard 降级/恢复逻辑', () => {
  let guard: MemoryGuard | null = null;

  afterEach(() => {
    if (guard) {
      guard.dispose();
      guard = null;
    }
    // 还原 performance.memory，避免用例间状态污染
    delete (performance as unknown as { memory?: unknown }).memory;
  });

  it('连续 DEGRADE_TRIGGER_COUNT 次严重采样才降级，且持续严重不抖动', () => {
    setMemory(0.95); // 严重：ratio 0.95 ≥ CRITICAL_HEAP_RATIO(0.9)
    guard = new MemoryGuard();
    expect(guard.isDegraded()).toBe(false);

    // 前 DEGRADE_TRIGGER_COUNT-1 次不足，不应降级
    for (let i = 0; i < DEGRADE_TRIGGER_COUNT - 1; i++) {
      check(guard);
      expect(guard.isDegraded()).toBe(false);
    }
    // 第 DEGRADE_TRIGGER_COUNT 次 → 降级
    check(guard);
    expect(guard.isDegraded()).toBe(true);

    // 持续严重：仍保持降级（不抖动）
    check(guard);
    expect(guard.isDegraded()).toBe(true);
  });

  it('单次严重后回落不降级（瞬时尖峰不误伤）', () => {
    setMemory(0.95); // 1 次严重
    guard = new MemoryGuard();
    check(guard);

    // 回落到正常
    setMemory(0.5); // ratio 0.5 < WARNING_HEAP_RATIO(0.8)
    check(guard);
    check(guard);

    expect(guard.isDegraded()).toBe(false);
  });

  it('降级后连续 DEGRADE_RECOVERY_COUNT 次正常才恢复（与触发对称）', () => {
    setMemory(0.95);
    guard = new MemoryGuard();
    // 先连续严重使其降级
    for (let i = 0; i < DEGRADE_TRIGGER_COUNT; i++) check(guard);
    expect(guard.isDegraded()).toBe(true);

    // 回到正常：前 DEGRADE_RECOVERY_COUNT-1 次尚不足以恢复
    setMemory(0.5);
    for (let i = 0; i < DEGRADE_RECOVERY_COUNT - 1; i++) {
      check(guard);
      expect(guard.isDegraded()).toBe(true);
    }
    // 第 DEGRADE_RECOVERY_COUNT 次 → 恢复
    check(guard);
    expect(guard.isDegraded()).toBe(false);
  });

  it('临界计数边界：1 次严重不降级，正好 DEGRADE_TRIGGER_COUNT 次才降级', () => {
    setMemory(0.95);
    guard = new MemoryGuard();

    // 边界：恰好 DEGRADE_TRIGGER_COUNT-1 次严重 → 不该降级
    for (let i = 0; i < DEGRADE_TRIGGER_COUNT - 1; i++) {
      check(guard);
      expect(guard.isDegraded()).toBe(false);
    }
    // 达到 DEGRADE_TRIGGER_COUNT 次 → 降级
    check(guard);
    expect(guard.isDegraded()).toBe(true);
  });
});
