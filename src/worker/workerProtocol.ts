/**
 * Worker 消息协议
 * ===============
 * 改进依据: 反思报告 P2-2 — 需增加 'log' 消息类型用于 Worker→主线程日志桥接
 * 
 * 未来扩展:
 *   新增消息类型 'log':
 *   { type: 'log', level: 'info'|'warn'|'error', module: string, message: string, data?: any, timestamp: number }
 *   主线程 WorkerManager 统一消费并转发到日志面板
 * 
 * ---
 * src/worker/workerProtocol.ts — Worker 消息协议定义
 *
 * 严格遵循 system_design.md §3.3 的消息格式定义。
 * 所有主线程↔Worker 通信必须使用此模块的消息格式。
 *
 * 注意：OutboundMessage / InboundMessage 类型定义在 src/types/worker.ts 中，
 * 其中 init.payload 已包含 executionProvider 字段（T01 已更新）。
 */

import type { OutboundMessage, InboundMessage } from '@/types';

// ── 工厂函数 ──

/** 生成 UUID v4 格式的任务 ID */
export function generateTaskId(): string {
  return crypto.randomUUID();
}

/** 创建出站消息 */
export function createMessage<T extends OutboundMessage['type']>(
  type: T,
  payload: Extract<OutboundMessage, { type: T }>['payload'],
  taskId?: string,
): Extract<OutboundMessage, { type: T }> {
  return {
    type,
    taskId: taskId ?? generateTaskId(),
    payload,
  } as Extract<OutboundMessage, { type: T }>;
}

/** 运行时校验入站消息格式 */
export function validateMessage(msg: unknown): msg is InboundMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== 'string') return false;
  if (typeof m.taskId !== 'string') return false;
  // 改进依据: 反思报告 P2-2 — 未来新增 'log' 类型: ['progress', 'result', 'error', 'health_report', 'log']
  if (!['progress', 'result', 'error', 'health_report'].includes(m.type)) return false;
  return true;
}

// ── 消息序列化工具 ──

/**
 * 递归收集可 Transferable 对象
 * 深度遍历对象属性，提取所有 TypedArray/ArrayBuffer
 */
function collectTransferables(obj: unknown, transfer: Transferable[]): void {
  if (obj instanceof ArrayBuffer) {
    // 跳过已 detach 的 buffer (byteLength 归零)
    if (obj.byteLength > 0) transfer.push(obj);
  } else if (obj instanceof Float32Array || obj instanceof Int32Array || obj instanceof Uint8Array) {
    // 防御: buffer 可能已被之前 transfer 操作 detach
    const buf = obj.buffer;
    if (buf.byteLength > 0) transfer.push(buf);
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      collectTransferables(val, transfer);
    }
  }
}

/**
 * 创建 Transferable 的 postMessage 参数
 * 提取 ArrayBuffer 以零拷贝传输（递归提取嵌套对象中的 buffer）
 */
export function toTransferable(data: unknown): { payload: unknown; transfer: Transferable[] } {
  const transfer: Transferable[] = [];
  collectTransferables(data, transfer);
  return { payload: data, transfer };
}

export const WorkerProtocol = {
  generateTaskId,
  createMessage,
  validateMessage,
  toTransferable,
} as const;
