/**
 * src/core/eventBus.ts — 轻量发布-订阅事件总线
 *
 * 用于 UI 组件间的解耦通信（如 StatusBar 订阅 Worker 状态变更）。
 */

import { logger } from '@/core/logger';

type EventHandler = (...args: unknown[]) => void;

class EventBus {
  private listeners: Map<string, Set<EventHandler>> = new Map();

  /** 注册事件监听，返回 unsubscribe 函数 */
  on(event: string, handler: EventHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => {
      const set = this.listeners.get(event);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  /** 移除事件监听 */
  off(event: string, handler: EventHandler): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /** 触发事件 */
  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const handler of set) {
        try {
          handler(...args);
        } catch (err) {
          logger.error(`[EventBus] Error in handler for "${event}":`, err);
        }
      }
    }
  }

  /** 移除所有监听器 */
  clear(): void {
    this.listeners.clear();
  }
}

/** 全局单例 */
export const eventBus = new EventBus();

// ── 预定义事件名 ──
export const AppEvents = {
  /** Worker 状态变更 (status: WorkerStatus) */
  WORKER_STATUS_CHANGED: 'worker:status-changed',
  /** 内存快照更新 (snapshot: MemorySnapshot) */
  MEMORY_SNAPSHOT: 'memory:snapshot',
  /** 降级模式变更 (degraded: boolean) */
  DEGRADE_CHANGED: 'memory:degrade-changed',
  /** 模型加载进度 (filename: string, status: ModelStatus, progress: number) */
  MODEL_PROGRESS: 'model:progress',
  /** 模型全部加载完成 (allVerified: boolean) */
  MODEL_ALL_COMPLETE: 'model:all-complete',
  /** 自检完成 (report: SelfTestReport) */
  SELFTEST_COMPLETE: 'selftest:complete',
  /** 全局锁状态变更 (locked: boolean) */
  LOCK_CHANGED: 'lock:changed',
  /** EP（执行提供程序）变更 (status: EPStatus) */
  EP_CHANGED: 'ep:changed',

  // ── 诊断 / 分级通知事件 ──
  /** 诊断发现一个问题（result: DiagnosticResult）— 通知中心据此分级反馈 */
  DIAGNOSTIC_ISSUE: 'diagnostic:issue',
  /** 全部诊断完成（可选，无载荷） */
  DIAGNOSTICS_DONE: 'diagnostic:done',

  // ── M3 音色建档事件 ──
  /** 音色建档进度更新 (progress: SynthesisProgress) */
  VOICE_DESIGN_PROGRESS: 'voice-design:progress',
  /** 音色建档完成 (result: SynthesisResult) */
  VOICE_DESIGN_COMPLETE: 'voice-design:complete',
  /** 音色建档错误 (error: string) */
  VOICE_DESIGN_ERROR: 'voice-design:error',
  /** 音色存储变更（新增/删除/重命名） */
  VOICE_STORAGE_CHANGED: 'voice-storage:changed',
  /** 应用关闭前释放资源（beforeunload） */
  SHUTDOWN: 'app:shutdown',
  /** 模型目录已加载就绪（ready: boolean，true=已加载）—— 供 StatusBar 展示恢复入口 */
  MODEL_DIR_READY: 'modeldir:ready',
} as const;
