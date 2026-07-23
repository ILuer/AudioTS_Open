/// <reference types="vite/client" />

/** Vite 环境变量类型声明 */
interface ImportMetaEnv {
  /** 运行模式：dev（开发，本地目录）| prod（生产，用户下载） */
  readonly VITE_APP_MODE: 'dev' | 'prod';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 由 vite.config.ts define 注入的应用元信息（运行时常量，非硬编码） */
declare const __APP_NAME__: string;
declare const __APP_VERSION__: string;
