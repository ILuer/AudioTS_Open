/**
 * src/worker/taskQueue.ts — 串行任务队列（互斥锁）
 *
 * 同一时间仅一个任务执行，后续任务排队。
 * 支持清空队列（用于 Worker 重建场景）。
 */

import type { TaskQueueItem } from '@/types';

export class TaskQueue {
  private queue: TaskQueueItem[] = [];
  private isRunning = false;
  private currentTask: TaskQueueItem | null = null;

  /** 入队并返回 Promise（任务完成后 resolve） */
  enqueue<T = unknown>(item: Omit<TaskQueueItem, 'status'>): Promise<T> {
    const task: TaskQueueItem = {
      ...item,
      status: 'queued',
    };

    return new Promise<T>((resolve, reject) => {
      const wrappedItem: TaskQueueItem & { resolve: (v: T) => void; reject: (e: Error) => void } = {
        ...task,
        resolve,
        reject,
      };

      this.queue.push(wrappedItem as unknown as TaskQueueItem);
      // Queue operations are routine — no logging needed

      // 触发执行
      this.processNext();
    });
  }

  /** 出队下一个任务 */
  dequeue(): TaskQueueItem | null {
    if (this.queue.length === 0) return null;
    return this.queue.shift() ?? null;
  }

  /** 队列是否为空 */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** 队列长度 */
  get length(): number {
    return this.queue.length;
  }

  /** 是否有任务正在执行 */
  get running(): boolean {
    return this.isRunning;
  }

  /** 获取当前执行中的任务 */
  getCurrentTask(): TaskQueueItem | null {
    return this.currentTask;
  }

  /** 标记当前任务完成 */
  completeTask(result: unknown): void {
    const task = this.currentTask as (TaskQueueItem & { resolve: (v: unknown) => void }) | null;
    if (task?.resolve) {
      task.resolve(result);
    }
    this.currentTask = null;
    this.isRunning = false;
    this.processNext();
  }

  /** 标记当前任务失败 */
  failTask(error: Error): void {
    const task = this.currentTask as (TaskQueueItem & { reject: (e: Error) => void }) | null;
    if (task?.reject) {
      task.reject(error);
    }
    this.currentTask = null;
    this.isRunning = false;
    this.processNext();
  }

  /** 清空队列（队列中未执行的任务将被 reject） */
  clear(): void {
    const cancelled = this.queue.splice(0, this.queue.length);
    for (const item of cancelled) {
      const task = item as unknown as { reject: (e: Error) => void };
      task.reject?.(new Error('Task cancelled: queue cleared'));
    }
  }

  /** 处理下一个任务 */
  private processNext(): void {
    if (this.isRunning || this.queue.length === 0) return;

    const next = this.dequeue();
    if (!next) return;

    this.isRunning = true;
    this.currentTask = next;

    // 触发 enqueue() 返回的 Promise，通知调用方任务已出队可执行
    const wrapped = next as unknown as { resolve?: (v: unknown) => void };
    wrapped.resolve?.(next);

    // Start execution silently — individual model timing logged in worker
  }
}
