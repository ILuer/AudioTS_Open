/**
 * main.tsx — AudioTS 配音系统入口
 *
 * 引入设计令牌与全局样式；不再使用 MUI ThemeProvider / CssBaseline。
 * 仅保留开发期手动调用的 __selftest / __decodeRef 调试钩子（日志经 logger）。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { logger } from './core/logger';

// 🔵 开发调试钩子：自检 & 参考码解码（仅手动在控制台调用）
(window as any).__selftest = async function () {
  const sm = (window as any).__sm;
  if (!sm) {
    logger.error('SessionManager 未就绪，请先运行 __loadModels');
    return;
  }
  let modelWaited = 0;
  while (!sm.buffersReady && modelWaited < 120) {
    await new Promise((r) => setTimeout(r, 1000));
    modelWaited++;
  }
  if (!sm.buffersReady) {
    logger.error(`模型文件超时未就绪（${modelWaited}s）`);
    return;
  }
  const { runSelfTest } = await import('./pipeline/selfTest');
  return runSelfTest(sm);
};

// 🔵 用 Python 参考 codes 通过 TS tok_decoder 解码验证
(window as any).__decodeRef = async function () {
  const sm = (window as any).__sm;
  if (!sm?.buffersReady) {
    logger.error('模型未就绪，请先运行 __loadModels');
    return;
  }
  const { decodeReferenceCodes } = await import('./pipeline/selfTest');
  return decodeReferenceCodes(sm);
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Fatal: #root element not found in DOM.');

// 由 vite define 注入的应用名称与版本号（来自 package.json），动态设置页面标题，禁止硬编码
document.title = `${__APP_NAME__} v${__APP_VERSION__}`;

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
