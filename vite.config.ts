import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';
import fs from 'fs';
import pkg from './package.json';

// remove JSEP WASM (26MB, >Cloudflare 25MB limit) from dist/assets/ after rollup bundle
function removeJsepWasm() {
  let outDir = '';
  return {
    name: 'remove-jsep-wasm',
    configResolved(cfg: { build: { outDir: string } }) {
      outDir = cfg.build.outDir;
    },
    closeBundle() {
      const assetsDir = path.resolve(outDir, 'assets');
      if (!fs.existsSync(assetsDir)) return;
      for (const f of fs.readdirSync(assetsDir)) {
        if (f.includes('jsep') && f.endsWith('.wasm')) {
          fs.unlinkSync(path.join(assetsDir, f));
          console.log(`[jsep-cleanup] removed ${f}`);
        }
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  // 注入应用名称与版本号（来自 package.json），供 main.tsx 设置 <title>，禁止硬编码
  define: {
    __APP_NAME__: JSON.stringify(pkg.appName),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    removeJsepWasm(),
    viteStaticCopy({
      targets: [
        // exclude jsep (WebGPU JIT, 26MB) — Cloudflare Pages 25MB limit
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs', dest: 'ort' },
      ],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      // Allow serving project files + Models directory for dev mode
      allow: [path.resolve(__dirname, 'Models'), path.resolve(__dirname, '.')],
    },
    // CRITICAL: Exclude ONNX model files from file watching to prevent OOM
    watch: {
      ignored: ['**/Models/**/*.onnx', '**/node_modules/**', '**/.git/**', '**/dist/**'],
    },
  },
  publicDir: 'public',
  // Ensure Models directory is served as static files in dev mode
  // Models/ is outside src/ so Vite serves it via the public directory or fs.allow
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  build: {
    target: 'es2022',
    // 消除 Vite 默认注入的内联 modulepreload polyfill <script>，
    // 该内联脚本会被 meta CSP 的 script-src（无 'unsafe-inline'）拦截（错误2）。
    // 现代浏览器原生支持 <link rel="modulepreload">，无需此 polyfill。
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: {
          'ort': ['onnxruntime-web'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
  // 改进依据: 状态盘点报告 P0-3 — IIFE format 与 code-splitting 冲突
  // module Worker (type: 'module') 配合 manualChunks 分包时，Vite Worker 插件
  // 默认生成 IIFE 格式 Worker 产物，与 code-splitting 不兼容。
  // 显式指定 Worker 输出格式为 ES module，绕过此限制。
  worker: {
    format: 'es',
  },
});
