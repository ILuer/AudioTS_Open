/**
 * src/core/browserCapability.ts — 浏览器兼容性检测矩阵
 *
 * 7 项检测：SharedArrayBuffer, WASM SIMD, WebGPU, FSAA, AudioContext, IndexedDB, WebCrypto
 * 分级：full（全部 critical 通过）/ partial（critical 通过但缺 recommended）/ unavailable（任意 critical 失败）
 *
 * WASM SIMD 检测使用 WebAssembly.validate() 验证一段含 i8x16.splat 指令的模块。
 * Edge/Chrome 91+ 均内置支持 WASM SIMD，无需手动开启 flags。
 *
 * WebGPU 检测使用 navigator.gpu + Chrome/Edge >= 121 双重判定（MatMulNBits 支持）。
 */

import type { CompatibilityItem, CompatibilityReport, BrowserGrade } from '@/types';
import { CHROME_MIN_WEBGPU_VERSION } from '@/core/constants';

/** 解析浏览器名称 */
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

/** 检测 SharedArrayBuffer（需要 crossOriginIsolated） */
function checkSharedArrayBuffer(): CompatibilityItem {
  const supported = typeof SharedArrayBuffer !== 'undefined';
  const crossOriginIsolated = typeof window !== 'undefined' && window.crossOriginIsolated;

  return {
    key: 'sharedArrayBuffer',
    label: 'SharedArrayBuffer',
    supported: supported && crossOriginIsolated,
    detail: supported && crossOriginIsolated
      ? '跨域隔离已启用'
      : supported
        ? 'SAB 存在但未跨域隔离（需 COOP/COEP 头）'
        : '不支持 SharedArrayBuffer',
    severity: 'critical',
  };
}

/** 检测 WebAssembly SIMD */
function checkWasmSimd(): CompatibilityItem {
  let supported = false;
  let detail = '';

  try {
    // 通过 WebAssembly.validate 检测 SIMD 支持
    // 模块: () -> () { i32.const 0; i8x16.splat; drop }
    // i8x16.splat (0xFD 0x0F) 将标量 i32 复制到 v128 向量的每个字节
    // 函数栈: [] -> [i32] -> [v128] -> [] -> (return)
    // 如果浏览器不支持 SIMD，validate 返回 false
    //
    // 原实现存在 2 个 Bug 导致 Edge 149 等浏览器误判为不支持：
    //   1) v128.any_true 需栈上已有 v128，空栈→类型检查失败
    //   2) end(0x0b) 字节位于 code section size 之外，函数体无结尾→结构非法
    const simdBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,          // magic
      0x01, 0x00, 0x00, 0x00,          // version 1
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: func () -> ()
      0x03, 0x02, 0x01, 0x00,          // func: 1, type 0
      0x0a, 0x09, 0x01, 0x07, 0x00,    // code: 1 func, body_size=7, 0 locals
      0x41, 0x00,                       // i32.const 0 (push scalar to stack)
      0xfd, 0x0f,                       // i8x16.splat (i32 -> v128, SIMD instruction)
      0x1a,                             // drop (pop v128 from stack)
      0x0b,                             // end
    ]);
    supported = WebAssembly.validate(simdBytes);
    detail = supported ? 'WASM SIMD 可用' : 'WASM SIMD 不可用 — ONNX Runtime Web int4 模型推理必需此项';
  } catch {
    supported = false;
    detail = 'WebAssembly 不可用';
  }

    return {
      key: 'wasmSimd',
      label: 'WebAssembly SIMD',
      supported,
      detail,
      severity: 'critical',
    };
}

/** 检测 WebGPU（navigator.gpu + Chrome/Edge >= 121） */
function checkWebGPU(): CompatibilityItem {
  let supported = false;
  let detail = '';

  try {
    const hasGpuApi = typeof navigator !== 'undefined' && 'gpu' in navigator;
    if (!hasGpuApi) {
      return {
        key: 'webgpu',
        label: 'WebGPU',
        supported: false,
        detail: '浏览器不支持 WebGPU API（navigator.gpu 不可用）',
        severity: 'recommended',
      };
    }

    const ua = navigator.userAgent;
    const chromeMatch = ua.match(/Chrome\/(\d+)/);
    const edgeMatch = ua.match(/Edg\//);
    const chromeVersion = chromeMatch ? parseInt(chromeMatch[1], 10) : 0;
    const isChrome = ua.includes('Chrome/') && !edgeMatch;
    const isEdge = !!edgeMatch;

    if ((isChrome || isEdge) && chromeVersion >= CHROME_MIN_WEBGPU_VERSION) {
      supported = true;
      detail = `WebGPU 可用 (${isEdge ? 'Edge' : 'Chrome'} ${chromeVersion})`;
    } else if (isChrome || isEdge) {
      detail = `${isEdge ? 'Edge' : 'Chrome'} ${chromeVersion} 不支持 MatMulNBits（需 >= ${CHROME_MIN_WEBGPU_VERSION}）`;
    } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
      detail = 'Safari WebGPU 实验性支持（建议使用 Chrome/Edge 121+）';
    } else if (ua.includes('Firefox/')) {
      detail = 'Firefox 不支持 WebGPU';
    } else {
      detail = '当前浏览器不支持 WebGPU';
    }
  } catch {
    supported = false;
    detail = 'WebGPU 检测失败';
  }

  return {
    key: 'webgpu',
    label: 'WebGPU',
    supported,
    detail,
    severity: 'recommended',
  };
}

/** 检测 File System Access API */
function checkFileSystemAccess(): CompatibilityItem {
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  return {
    key: 'fileSystemAccess',
    label: 'File System Access API',
    supported,
    detail: supported ? 'showDirectoryPicker 可用' : '不支持目录选择，需使用 <input webkitdirectory>',
    severity: 'recommended',
  };
}

/** 检测 AudioContext */
function checkAudioContext(): CompatibilityItem {
  const supported = typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined';

  return {
    key: 'audioContext',
    label: 'AudioContext',
    supported,
    detail: supported ? 'AudioContext 可用' : '不支持 AudioContext / webkitAudioContext',
    severity: 'critical',
  };
}

/** 检测 IndexedDB */
function checkIndexedDB(): CompatibilityItem {
  const supported = typeof indexedDB !== 'undefined';

  return {
    key: 'indexedDB',
    label: 'IndexedDB',
    supported,
    detail: supported ? 'IndexedDB 可用' : '不支持 IndexedDB',
    severity: 'recommended',
  };
}

/** 检测 Web Crypto API */
function checkWebCrypto(): CompatibilityItem {
  const supported = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';

  return {
    key: 'webCrypto',
    label: 'Web Crypto API',
    supported,
    detail: supported ? 'SubtleCrypto 可用' : '不支持 crypto.subtle',
    severity: 'critical',
  };
}

/** 计算浏览器兼容性等级 */
function getGrade(report: CompatibilityReport): BrowserGrade {
  const criticalItems = report.items.filter((item) => item.severity === 'critical');
  const allCriticalPassed = criticalItems.every((item) => item.supported);

  if (!allCriticalPassed) return 'unavailable';

  const allPassed = report.items.every((item) => item.supported);
  if (allPassed) return 'full';
  return 'partial';
}

/** 执行全部 7 项检测，返回完整报告 */
export function detectAll(): CompatibilityReport {
  const items: CompatibilityItem[] = [
    checkSharedArrayBuffer(),
    checkWasmSimd(),
    checkWebGPU(),
    checkFileSystemAccess(),
    checkAudioContext(),
    checkIndexedDB(),
    checkWebCrypto(),
  ];

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'SSR';
  const { name, version } = parseBrowser(ua);

  const report: Omit<CompatibilityReport, 'grade'> = {
    timestamp: Date.now(),
    userAgent: ua,
    browserName: name,
    browserVersion: version,
    items,
    passedCount: items.filter((i) => i.supported).length,
    totalCount: items.length,
  };

  return {
    ...report,
    grade: getGrade(report as CompatibilityReport),
  };
}

export const BrowserCapability = {
  detectAll,
  checkSharedArrayBuffer,
  checkWasmSimd,
  checkWebGPU,
  checkFileSystemAccess,
  checkAudioContext,
  checkIndexedDB,
  checkWebCrypto,
  getGrade,
} as const;
