/**
 * src/memory/memoryGuard.ts — 全链路内存防护
 *
 * 监控 JS 堆内存使用，在达到阈值时触发降级。
 *
 * Chrome: 使用 performance.memory.jsHeapSizeLimit × 80% 作为告警线
 * 其他浏览器: 使用 FALLBACK_JS_HEAP_LIMIT (2GB) 作为静态告警线
 *
 * 降级模式：拒绝新推理任务，已有任务继续运行。
 * 恢复条件：连续 2 次采样低于告警阈值。
 */

import {
  WARNING_HEAP_RATIO,
  CRITICAL_HEAP_RATIO,
  FALLBACK_JS_HEAP_LIMIT,
  MEMORY_MONITOR_INTERVAL_MS,
  DEGRADE_RECOVERY_COUNT,
  DEGRADE_TRIGGER_COUNT,
} from '@/core/constants';
import { eventBus, AppEvents } from '@/core/eventBus';
import type { MemorySnapshot } from '@/types';
import { logger } from '@/core/logger';

export class MemoryGuard {
  private warningThreshold: number = 0;
  private criticalThreshold: number = 0;
  private degraded = false;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private warningCallbacks: Array<(snapshot: MemorySnapshot) => void> = [];
  private criticalCallbacks: Array<(snapshot: MemorySnapshot) => void> = [];
  private recoveryCount = 0;
  private criticalCount = 0;

  constructor() {
    this.calculateThresholds();
  }

  // ── 公共 API ──

  /** 开始定时监控 */
  startMonitoring(intervalMs: number = MEMORY_MONITOR_INTERVAL_MS): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => {
      this.check();
    }, intervalMs);
  }

  /** 停止定时监控 */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /** 拍摄内存快照 */
  takeSnapshot(): MemorySnapshot {
    const mem = this.getMemoryInfo();

    return {
      jsHeapSizeLimit: mem.jsHeapSizeLimit,
      totalJSHeapSize: mem.totalJSHeapSize,
      usedJSHeapSize: mem.usedJSHeapSize,
      timestamp: Date.now(),
    };
  }

  /** 是否处于降级模式 */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** 注册告警回调 */
  onWarning(callback: (snapshot: MemorySnapshot) => void): void {
    this.warningCallbacks.push(callback);
  }

  /** 注册严重告警回调 */
  onCritical(callback: (snapshot: MemorySnapshot) => void): void {
    this.criticalCallbacks.push(callback);
  }

  /** 释放资源 */
  dispose(): void {
    this.stopMonitoring();
    this.warningCallbacks = [];
    this.criticalCallbacks = [];
    this.criticalCount = 0;
  }

  // ── 私有方法 ──

  /** 执行一次内存检测 */
  private check(): void {
    const snapshot = this.takeSnapshot();
    const usedMB = snapshot.usedJSHeapSize / (1024 * 1024);
    const limitMB = snapshot.jsHeapSizeLimit / (1024 * 1024);
    const ratio = limitMB > 0 ? snapshot.usedJSHeapSize / snapshot.jsHeapSizeLimit : 0;

    // 发送快照事件
    eventBus.emit(AppEvents.MEMORY_SNAPSHOT, snapshot);

    if (ratio >= CRITICAL_HEAP_RATIO) {
      // 严重 → 累积计数，连续达到阈值次数才自动降级（避免瞬时尖峰误伤）
      this.criticalCount++;
      if (!this.degraded && this.criticalCount >= DEGRADE_TRIGGER_COUNT) {
        logger.warn(`[MemoryGuard] ⚠️ JS堆使用率 ${(ratio * 100).toFixed(1)}% 达到严重阈值，进入降级模式`);
        this.degraded = true;
        this.recoveryCount = 0;
        eventBus.emit(AppEvents.DEGRADE_CHANGED, true);
        for (const cb of this.criticalCallbacks) {
          try { cb(snapshot); } catch (err) { logger.error('[MemoryGuard] Critical callback error:', err); }
        }
      }
    } else if (ratio >= WARNING_HEAP_RATIO) {
      // 告警
      this.criticalCount = 0;
      logger.warn(`[MemoryGuard] JS堆使用率 ${(ratio * 100).toFixed(1)}% 接近告警阈值`);
      for (const cb of this.warningCallbacks) {
        try { cb(snapshot); } catch (err) { logger.error('[MemoryGuard] Warning callback error:', err); }
      }
      // 未达到严重阈值，重置恢复计数
      this.recoveryCount = 0;
    } else {
      // 正常 → 检查是否需要恢复
      this.criticalCount = 0;
      if (this.degraded) {
        this.recoveryCount++;
        if (this.recoveryCount >= DEGRADE_RECOVERY_COUNT) {
          this.degraded = false;
          this.recoveryCount = 0;
          eventBus.emit(AppEvents.DEGRADE_CHANGED, false);
        }
      }
    }
  }

  /** 获取内存信息（兼容 Chrome 和非 Chrome） */
  private getMemoryInfo(): { jsHeapSizeLimit: number; totalJSHeapSize: number; usedJSHeapSize: number } {
    // Chrome: performance.memory
    const perfMemory = (performance as any).memory;
    if (perfMemory && typeof perfMemory.jsHeapSizeLimit === 'number') {
      return {
        jsHeapSizeLimit: perfMemory.jsHeapSizeLimit,
        totalJSHeapSize: perfMemory.totalJSHeapSize,
        usedJSHeapSize: perfMemory.usedJSHeapSize,
      };
    }

    // Fallback: 使用 navigator.deviceMemory 估算
    const deviceMemoryGB = (navigator as any).deviceMemory as number | undefined;
    if (deviceMemoryGB) {
      const limit = deviceMemoryGB * 1024 * 1024 * 1024;
      return {
        jsHeapSizeLimit: limit,
        totalJSHeapSize: limit * 0.5,
        usedJSHeapSize: limit * 0.3, // 粗略估计
      };
    }

    // 最终 fallback
    return {
      jsHeapSizeLimit: FALLBACK_JS_HEAP_LIMIT,
      totalJSHeapSize: FALLBACK_JS_HEAP_LIMIT * 0.4,
      usedJSHeapSize: FALLBACK_JS_HEAP_LIMIT * 0.2,
    };
  }

  /** 重新计算阈值 */
  private calculateThresholds(): void {
    const mem = this.getMemoryInfo();
    this.warningThreshold = mem.jsHeapSizeLimit * WARNING_HEAP_RATIO;
    this.criticalThreshold = mem.jsHeapSizeLimit * CRITICAL_HEAP_RATIO;
  }
}
