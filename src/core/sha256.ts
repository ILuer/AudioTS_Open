/**
 * src/core/sha256.ts — SHA-256 计算（Web Crypto API）
 *
 * 直接使用 file.arrayBuffer() 整文件读取。
 * 现代 Chrome 64-bit 可轻松处理 ~911MB 的 ArrayBuffer。
 */
import { SHA256_CHUNK_SIZE } from '@/core/constants';

/**
 * 从 ArrayBuffer 计算 SHA-256 哈希（hex 小写）
 */
export async function computeFromBuffer(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(hashBuffer);
}

/**
 * 从 File 对象计算 SHA-256
 *
 * 直接调用 file.arrayBuffer() 整文件读取，再走 computeFromBuffer。
 * 不再使用分块拼接方案 —— 此前逐块 SHA256 → 拼接 hash → 再 SHA256
 * 的方案与标准 SHA-256 完全不同，导致所有 >2MB ONNX 文件校验 100% 失败。
 */
export async function computeFromFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return computeFromBuffer(buffer);
}

/**
 * 一站式校验：计算 File 的 SHA-256 并与期望值对比
 */
export async function verifyFile(file: File, expectedHex: string): Promise<boolean> {
  const actualHex = await computeFromFile(file);
  return actualHex === expectedHex.toLowerCase();
}

/**
 * 将 ArrayBuffer 转为小写 hex 字符串
 */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = SHA256_CHUNK_SIZE;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    let chunk = '';
    for (let j = i; j < end; j++) {
      chunk += bytes[j].toString(16).padStart(2, '0');
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

export const Sha256Calculator = {
  computeFromFile,
  computeFromBuffer,
  verifyFile,
} as const;
