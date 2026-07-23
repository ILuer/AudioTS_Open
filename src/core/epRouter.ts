/**
 * src/core/epRouter.ts — EP（执行提供程序）选择与 sessionStorage 缓存路由
 *
 * 启动时决定使用 WebGPU 还是 WASM CPU 执行推理。
 * 检测逻辑：navigator.gpu 存在 + Chrome/Edge >= 121 → 尝试 WebGPU 导入 → 成功缓存。
 */

import type { ExecutionProvider, EPCheckResult } from '@/types';
import {
  EP_CACHE_KEY,
  CHROME_MIN_WEBGPU_VERSION,
  EP_WEBGPU,
  EP_WASM,
} from '@/core/constants';
import { logger } from '@/core/logger';

// ── 内部辅助 ──

/** 解析浏览器名称和 Chrome 版本号（Edge UA 也包含 Chrome/ 版本号） */
function parseBrowser(ua: string): { name: string; version: string } {
  let name = 'Unknown';
  let version = 'Unknown';

  if (ua.includes('Edg/')) {
    name = 'Edge';
    const m = ua.match(/Edg\/([\d.]+)/);
    if (m) version = m[1];
  } else if (ua.includes('Chrome/')) {
    name = 'Chrome';
    const m = ua.match(/Chrome\/([\d.]+)/);
    if (m) version = m[1];
  } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
    name = 'Safari';
    const m = ua.match(/Version\/([\d.]+)/);
    if (m) version = m[1];
  } else if (ua.includes('Firefox/')) {
    name = 'Firefox';
    const m = ua.match(/Firefox\/([\d.]+)/);
    if (m) version = m[1];
  }

  return { name, version };
}

/** 检测 WebGPU API 是否存在（try-catch 保护以兼容 ES5 浏览器） */
function checkWebGPUAPI(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  } catch {
    return false;
  }
}

/** 解析 Chrome 主版本号（Edge 的 UA 中也包含 Chrome/ 版本号） */
function checkChromeVersion(): number {
  try {
    const ua = navigator.userAgent;
    const match = ua.match(/Chrome\/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/** 尝试动态导入 WebGPU 后端以验证其可用性（成功 → true，失败 → false） */
async function tryWebGPUInit(): Promise<boolean> {
  try {
    await import('onnxruntime-web/webgpu');
    return true;
  } catch (err) {
    logger.warn('[EPRouter] WebGPU 后端初始化失败，将回退到 WASM:', err);
    return false;
  }
}

// ── EPRouter 对象 ──

export const EPRouter = {
  /**
   * 同步检测 WebGPU 支持情况（不尝试实际初始化）。
   * 可用于兼容性检测 Tab 快速展示。
   */
  detect(): EPCheckResult {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const { name, version } = parseBrowser(ua);
    const chromeVersion = checkChromeVersion();
    const apiAvailable = checkWebGPUAPI();

    let webgpuAvailable = false;
    let webgpuReason = '';
    let provider: ExecutionProvider = EP_WASM;

    if (!apiAvailable) {
      webgpuReason = 'navigator.gpu 不可用';
    } else if (chromeVersion < CHROME_MIN_WEBGPU_VERSION) {
      webgpuReason = `Chrome ${chromeVersion} < ${CHROME_MIN_WEBGPU_VERSION}（缺少 MatMulNBits 支持）`;
    } else {
      webgpuAvailable = true;
      webgpuReason = 'WebGPU API 可用';
      provider = EP_WEBGPU;
    }

    return {
      provider,
      webgpuAvailable,
      webgpuReason,
      browserName: name,
      browserVersion: version,
      chromeVersion,
      gpuAdapterInfo: null,
    };
  },

  /**
   * 异步选择执行提供程序（含 sessionStorage 缓存逻辑）。
   *
   * 流程：
   * 1. 检查 sessionStorage 缓存 → 有则直接返回
   * 2. 同步检测 API + 版本 → 不满足则返回 'wasm'
   * 3. 尝试动态导入 WebGPU 后端 → 成功则缓存并返回 'webgpu'
   * 4. 失败则缓存 'wasm' 并返回
   */
  async selectEP(): Promise<ExecutionProvider> {
    const cached = EPRouter.getCachedEP();
    if (cached === 'webgpu') {
      return EP_WEBGPU;
    }
    // cached === 'wasm' 或无缓存：重新检测 WebGPU，避免盲信过期的 wasm 缓存
    // （之前 WebGPU 初始化失败会缓存 wasm，但环境恢复后应重试 webgpu）
    const checkResult = EPRouter.detect();

    if (checkResult.webgpuAvailable) {
      const webgpuOk = await tryWebGPUInit();
      if (webgpuOk) {
        EPRouter.cacheEP(EP_WEBGPU);
        return EP_WEBGPU;
      }
    }

    EPRouter.cacheEP(EP_WASM);
    return EP_WASM;
  },

  /** 从 sessionStorage 读取缓存的 EP 偏好 */
  getCachedEP(): ExecutionProvider | null {
    try {
      const cached = sessionStorage.getItem(EP_CACHE_KEY);
      if (cached === 'webgpu' || cached === 'wasm') {
        return cached;
      }
    } catch {
      // sessionStorage 不可用（隐私模式、iframe 沙箱等），静默忽略
    }
    return null;
  },

  /** 将 EP 偏好写入 sessionStorage 缓存 */
  cacheEP(ep: ExecutionProvider): void {
    try {
      sessionStorage.setItem(EP_CACHE_KEY, ep);
    } catch {
      // sessionStorage 写入失败（隐私模式等），静默忽略
    }
  },

  /** 清除 sessionStorage 中的 EP 缓存 */
  clearCache(): void {
    try {
      sessionStorage.removeItem(EP_CACHE_KEY);
    } catch {
      // 静默忽略
    }
  },
};
