/**
 * src/core/modelDir.ts — 模型目录管理器（FSAA 本地目录）
 * ========================================================
 *
 * 使用 File System Access API (showDirectoryPicker) 让用户选择
 * 包含 ONNX 模型文件的本地文件夹。FileSystemDirectoryHandle 通过
 * IndexedDB 持久化（跨会话），每次启动重新请求读取权限。
 */

import { logger } from '@/core/logger';

const DB_NAME = 'audiotts-modeldir';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'model_dir_handle';

/** Promise 化 IDB transaction 的 complete/error */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 获取已保存的 FileSystemDirectoryHandle。
 * 返回 null 表示尚未配置、浏览器不支持 FSAA、或权限被拒绝。
 */
export async function getSavedHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!('showDirectoryPicker' in window)) return null;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    const handle = await new Promise<any>((resolve) => { req.onsuccess = () => resolve(req.result); });
    await txDone(tx);
    if (!handle) return null;
    // 每次启动需重新请求权限
    const ok = await (handle as any).requestPermission({ mode: 'read' });
    return ok === 'granted' ? (handle as FileSystemDirectoryHandle) : null;
  } catch {
    return null;
  }
}

/**
 * 弹出目录选择器，保存用户选择的 FileSystemDirectoryHandle。
 * 返回选中的 handle，用户取消则返回 null。
 */
/**
 * 弹出目录选择器，保存用户选择的 FileSystemDirectoryHandle。
 * 返回选中的 handle，用户取消则返回 null。
 *
 * ⚠️ 不能用 async/await — showDirectoryPicker 必须从用户手势同步调用
 */
export function pickAndSaveHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!('showDirectoryPicker' in window)) {
    logger.warn('[ModelDir] showDirectoryPicker API 不可用');
    return Promise.resolve(null);
  }
  // 🔵 同步调用 showDirectoryPicker（不能用 await！用户手势会丢失）
  return (window as any).showDirectoryPicker({
    id: 'qwen3-tts-models',
    mode: 'readonly',
  }).then(async (handle: FileSystemDirectoryHandle) => {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    await txDone(tx);
    return handle;
  }).catch(() => null);
}

/**
 * 清除保存的目录配置。
 */
export async function clearSavedHandle(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
    await txDone(tx);
  } catch {
    // noop
  }
}

/**
 * 是否已配置过目录（IndexedDB 中有 handle 记录）。
 */
export async function hasSavedHandle(): Promise<boolean> {
  if (!('showDirectoryPicker' in window)) return false;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const val = await new Promise<any>((resolve) => {
      const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result);
    });
    await txDone(tx);
    return val !== undefined;
  } catch {
    return false;
  }
}

// ── 向后兼容：URL 模式 ──

const MODEL_DIR_URL_KEY = 'audiotts_model_dir';

export function getModelDir(): string {
  try {
    return localStorage.getItem(MODEL_DIR_URL_KEY)?.replace(/\/+$/, '') || 'Models';
  } catch {
    return 'Models';
  }
}

export function setModelDir(dir: string): void {
  try { localStorage.setItem(MODEL_DIR_URL_KEY, dir.trim().replace(/\/+$/, '')); } catch {}
}

// ── IndexedDB helper ──

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
