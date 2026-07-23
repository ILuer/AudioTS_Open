/**
 * 全局常量定义
 * ============
 * 改进依据: 反思报告 P2-3 — 计划自称"配置驱动"但当前全部硬编码
 * 
 * 配置驱动迁移（2025-07-14）:
 *   ✅ Token IDs / 结构参数 / 语言映射 → encodingRegistry（动态查询）
 *   ✅ 采样参数默认值 → encodingRegistry.getSamplingDefaults()
 *   ✅ 配置解析 → src/core/configLoader.ts
 * 
 * 保留的非模型常量:
 *   - 模型文件清单（VOICEDESIGN_MODEL_FILES）
 *   - 架构固定值（VD_DEC_FRAMES, VD_SR, OUTPUT_SAMPLE_RATE）
 *   - 内存/Worker/EP/IndexedDB 阈值与配置
 *   - UI 常量
 * 
 * 所有模块统一从此文件获取常量，禁止硬编码路径/阈值。
 */

import type { ModelFileInfo, ExecutionProvider, TextTemplate } from '@/types';
import { getModelDir } from '@/core/modelDir';

// ── VoiceDesign 模型集（相对路径，可移植） ──
// 目标 2：VoiceDesign 模型集从 Models/ 根目录加载 ONNX 文件。
// （相对项目根 / 工作空间；dev 走 /Models/...，prod 走 FSAA 选中目录）。
export const VOICEDESIGN_MODEL_DIR = 'Models';
/** 获取当前模型目录（优先用户自定义，fallback 到 Models/） */
export const getVoiceDesignModelDir = getModelDir;

// 改进依据: 状态盘点报告 P1-1 — 静态 fallback，优先从 manifest.json 动态加载
// 当 manifest.json 不可用或 loadModelFilesFromManifest() 失败时使用此硬编码清单。
// 8 个模型文件清单：7 个 manifest sub_model + 非缓存 talker.onnx（O(n²) AR 循环用）。
// sizeBytes 为磁盘实测值；sha256 暂置空字符串 '' 表示跳过校验（待补全实测值）。
// 注：tok_decoder/tok_encoder 与 Base 集权重字节完全一致，但为模型集隔离仍单独加载。
//     talker.onnx 磁盘存在但 manifest 未列；本集按文件清单加载（manifestDriven 当前未消费）。
export const VOICEDESIGN_MODEL_FILES: ModelFileInfo[] = [
  {
    filename: 'code_predictor.onnx',
    sizeBytes: 113_841_219,
    sha256: '',
    required: true,
  },
  {
    filename: 'codec_embed.onnx',
    sizeBytes: 4_031_014,
    sha256: '',
    required: true,
  },
  {
    filename: 'residual_embed.onnx',
    sizeBytes: 44_346_842,
    sha256: '',
    required: true,
  },
  {
    filename: 'talker_cache.onnx',
    sizeBytes: 911_514_323,
    sha256: '',
    required: false,
  },
  {
    // 非缓存 talker（O(n²) AR 循环用，本轮"跑通"方案）。
    filename: 'talker.onnx',
    sizeBytes: 910_912_341,
    sha256: '',
    required: true,
  },
  {
    filename: 'text_embed.onnx',
    sizeBytes: 204_732_501,
    sha256: '',
    required: true,
  },
  {
    filename: 'tok_decoder.onnx',
    sizeBytes: 458_268_831,
    sha256: '',
    required: true,
  },
  {
    filename: 'tok_encoder.onnx',
    sizeBytes: 225_554_101,
    sha256: '',
    required: false,  // 对齐计划：按需懒加载，当前 VoiceDesign 音色克隆支路未启用
  },
];

// ── 模型架构固定常量（非配置驱动） ──
// 以下值不是模型配置而是架构固有属性，保留为硬编码：
//   VD_DEC_FRAMES — tok_decoder 固定 25 帧解码块
//   VD_SR / OUTPUT_SAMPLE_RATE — 模型原生采样率 24000 Hz
// 
// 其余模型 token IDs / 结构参数 / 语言映射已迁移至：
//   encodingRegistry（src/core/encodingRegistry.ts）
//   从 config.json / generation_config.json / tokenizer_config.json 动态读取

/** tok_decoder 固定 25 帧解码块（架构固定，不在配置文件中） */
export const VD_DEC_FRAMES = 25;
/** 模型原生采样率（Python 模块常量 SR=24000） */
export const VD_SR = 24_000;

// ── 内存阈值 ──
/** JS 堆告警比例 (80%) */
export const WARNING_HEAP_RATIO = 0.8;

/** JS 堆严重告警比例 (90%) */
export const CRITICAL_HEAP_RATIO = 0.9;

/** 非 Chrome 浏览器 JS 堆 fallback 上限 (2 GB) */
export const FALLBACK_JS_HEAP_LIMIT = 2 * 1024 * 1024 * 1024;

/** 非 Chrome 浏览器 WASM 堆 fallback 上限 (3 GB) */
export const FALLBACK_WASM_HEAP_LIMIT = 3 * 1024 * 1024 * 1024;

// ── Worker 重建阈值 ──
/** 累计推理任务数达到此值触发 Worker 重建 */
export const REBUILD_TASK_COUNT = 50;

/** 连续 N 次推理后内存未回落触发 Worker 重建 */
export const REBUILD_MEMORY_LEAK_CHECK_COUNT = 3;

/** 内存未回落的判定阈值：当前堆使用量 > 基线 + 15% */
export const MEMORY_LEAK_BASELINE_RATIO = 0.15;

// ── 超时配置 ──
/** 单文件模型加载超时 (ms)，5 分钟 */
export const MODEL_LOAD_TIMEOUT_MS = 300_000;

/** 单个文件 SHA-256 计算分块大小 (2 MB) */
export const SHA256_CHUNK_SIZE = 2 * 1024 * 1024;

/** 实时内存监控轮询间隔 (ms) —— 1 秒一次，保证状态栏 JS 堆显示实时刷新 */
export const MEMORY_MONITOR_INTERVAL_MS = 1_000;

/** 降级恢复所需连续正常采样次数 */
export const DEGRADE_RECOVERY_COUNT = 2;

/** 连续达到严重阈值多少次才自动降级（防御瞬时尖峰误伤） */
export const DEGRADE_TRIGGER_COUNT = 2;

// ── E2E 自检 ──
/** 余弦相似度判定阈值 */
export const COSINE_THRESHOLD = 0.95;

// ── 外部链接 ──
/** HuggingFace 模型下载地址 */
// 改进依据: 反思报告 P2-3 — 计划一致性自检，修复 FIXME
// VoiceDesign 模型集下载地址（cpu_int4 量化版本）
// 用户需从 HuggingFace 下载 8 个 .onnx 文件放置到本地或服务器目录
export const HF_MODEL_URL = 'https://huggingface.co/onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign/tree/main/cpu_int4';

// ── 模型名称常量 ──
export const MODEL_NAMES = {
  TALKER: 'talker',
  TALKER_CACHE: 'talker_cache',
  TOK_ENCODER: 'tok_encoder',
  TOK_DECODER: 'tok_decoder',
  TEXT_EMBED: 'text_embed',
  CODEC_EMBED: 'codec_embed',
  CODE_PREDICTOR: 'code_predictor',
  RESIDUAL_EMBED: 'residual_embed',
  SPEAKER_ENCODER: 'speaker_encoder',
} as const;

// ── EP（执行提供程序）常量 ──
/** sessionStorage 缓存键名 */
export const EP_CACHE_KEY = 'ort-ep-preference';

/** Chrome 最低版本（需 ≥ 121 以支持 MatMulNBits） */
export const CHROME_MIN_WEBGPU_VERSION = 121;

/** WebGPU 执行提供程序标识 */
export const EP_WEBGPU: ExecutionProvider = 'webgpu';

/** WASM（CPU）执行提供程序标识 */
export const EP_WASM: ExecutionProvider = 'wasm';

// V2 pipeline uses AR_MAX_FRAMES=500 in ttsPipelineV2.ts (was MAX_NEW_TOKENS=30)
// 500 frames @12Hz ≈ 41 seconds max, EOS-based early stop
// Legacy: old ttsPipeline.ts uses its own local AR_MAX_FRAMES=500; this constant kept for backward compat
export const AR_MAX_FRAMES = 30;

/**
 * 合成输出采样率 (Hz)。
 * 对齐 Python inference.py SR=24000（L47）。
 * tok_decoder ONNX 模型在 24kHz 下训练/导出，输出即 24kHz PCM。
 */
export const OUTPUT_SAMPLE_RATE = 24000;

// 改进依据: 状态盘点报告 P1-2 — BPE tokenizer 文件从 HuggingFace 下载至 Models/ 根目录
/** BPE vocab.json 路径（与 ONNX 模型同目录） */
export const BPE_VOCAB_PATH = '/Models/vocab.json';

/** BPE merges.txt 路径 */
export const BPE_MERGES_PATH = '/Models/merges.txt';

/** BPE tokenizer_config.json 路径（Qwen2Tokenizer 配置） */
export const BPE_CONFIG_PATH = '/Models/tokenizer_config.json';

/** IndexedDB 数据库名称 */
export const IDB_DB_NAME = 'qwen3-tts-voices';

/** IndexedDB 存储对象名称 */
export const IDB_STORE_NAME = 'voiceProfiles';

/** IndexedDB 版本号 */
export const IDB_VERSION = 1;

/** WAV 格式支持的 MIME 类型 */
export const SUPPORTED_AUDIO_MIMES = [
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
];

/** WAV 文件头大小（字节） */
export const WAV_HEADER_SIZE = 44;

/** 波形峰值点数（用于 UI 绘制） */
export const WAVEFORM_PEAK_COUNT = 200;

/** 试听文本模板 */
export const TEXT_TEMPLATES: TextTemplate[] = [
  {
    name: '通用问候（普通话）',
    text: '你好，欢迎使用 Qwen3-TTS 语音合成系统。这是一个试听样本，用于评估音色建档效果。',
    language: 'zh/mandarin',
  },
  {
    name: '通用问候（粤语）',
    text: '你好，歡迎使用Qwen3-TTS語音合成系統。呢個係一個試聽樣本，用嚟評估音色建檔效果。',
    language: 'zh/cantonese',
  },
  {
    name: 'General Greeting (English)',
    text: 'Hello, welcome to the Qwen3-TTS voice synthesis system. This is a sample audio for evaluating the voice profile quality.',
    language: 'en/us',
  },
  {
    name: '一般的な挨拶（日本語）',
    text: 'こんにちは、Qwen3-TTS音声合成システムへようこそ。これは音色プロファイルの品質を評価するためのサンプル音声です。',
    language: 'ja',
  },
  {
    name: '新闻播报（普通话）',
    text: '据新华社报道，我国在人工智能语音合成领域取得了重要突破。新一代语音合成技术能够更加自然地模拟人类语音的韵律和情感。',
    language: 'zh/mandarin',
  },
];
