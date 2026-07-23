/**
 * src/types/encoding.ts — 配置驱动的模型编码类型定义
 *
 * 所有类型对应 Models/ 目录下 JSON 配置文件的结构。
 * 从原始 JSON shape 到标准化 ModelConfig 的转换由 configLoader.ts 负责。
 */

import type { VdLanguageOption } from './voice';

// ── 配置错误 ──

/** 配置文件解析/验证错误 */
export class ConfigError extends Error {
  constructor(
    public file: string,
    public field: string,
    message: string,
  ) {
    super(`[${file}${field ? '.' + field : ''}] ${message}`);
    this.name = 'ConfigError';
  }
}

// ── 原始 JSON 配置 shapes（与磁盘文件一一对应） ──

/** config.json 原始结构 */
export interface RawConfig {
  architectures: string[];
  assistant_token_id: number;
  im_end_token_id: number;
  im_start_token_id: number;
  tts_bos_token_id: number;
  tts_eos_token_id: number;
  tts_pad_token_id: number;
  model_type: string;
  tokenizer_type: string;
  talker_config: RawTalkerConfig;
}

/** config.json → talker_config */
export interface RawTalkerConfig {
  hidden_size: number;
  vocab_size: number;
  num_hidden_layers: number;
  num_attention_heads: number;
  num_key_value_heads: number;
  num_code_groups: number;
  head_dim: number;
  codec_eos_token_id: number;
  codec_pad_id: number;
  codec_bos_id: number;
  codec_think_id: number;
  codec_nothink_id: number;
  codec_think_bos_id: number;
  codec_think_eos_id: number;
  codec_language_id: Record<string, number>;
  code_predictor_config: RawCodePredictorConfig;
  text_vocab_size: number;
  text_hidden_size?: number;
  max_position_embeddings?: number;
  position_id_per_seconds?: number;
}

/** config.json → talker_config → code_predictor_config */
export interface RawCodePredictorConfig {
  vocab_size: number;
}

/** generation_config.json 原始结构 */
export interface RawGenerationConfig {
  do_sample: boolean;
  temperature: number;
  top_k: number;
  top_p: number;
  repetition_penalty: number;
  subtalker_dosample?: boolean;
  subtalker_temperature?: number;
  subtalker_top_k?: number;
  subtalker_top_p?: number;
  max_new_tokens?: number;
}

/** preprocessor_config.json 原始结构 */
export interface RawPreprocessorConfig {
  padding_side: string;
  padding_value: number;
  processor_class: string;
  return_attention_mask?: boolean;
}

/** tokenizer_config.json added_tokens_decoder 单条记录 */
export type AddedTokenEntry = Record<string, unknown>;

/** tokenizer_config.json 原始结构 */
export interface RawTokenizerConfig {
  add_bos_token?: boolean;
  add_prefix_space?: boolean;
  added_tokens_decoder?: Record<string, AddedTokenEntry>;
}

// ── 标准化模型配置 ──

/** codec 相关 token ID 与参数 */
export interface CodecTokens {
  eos: number;
  pad: number;
  bos: number;
  think: number;
  nothink: number;
  thinkBos: number;
  thinkEos: number;
  vocabSize: number;
  codePredictorVocabSize: number;
}

/** TTS 特殊 token */
export interface TtsTokens {
  bos: number;
  eos: number;
  pad: number;
}

/** Chat 模板 token */
export interface ChatTokens {
  imStart: number;
  imEnd: number;
  assistantId: number;
}

/** Talker 模型参数 */
export interface TalkerParams {
  hiddenSize: number;
  numLayers: number;
  numKvHeads: number;
  headDim: number;
  numCodeGroups: number;
  numPastTensors: number;
}

/** 采样默认值 */
export interface SamplingDefaults {
  doSample: boolean;
  temperature: number;
  topK: number;
  topP: number;
  repetitionPenalty: number;
  /** Code predictor (residual token) sampling — official subtalker_* params */
  subDoSample: boolean;
  subTemperature: number;
  subTopK: number;
  subTopP: number;
  /** AR loop max frame budget — from generation_config.json max_new_tokens */
  maxNewTokens: number;
}

/** 从配置文件解析出的标准化模型配置 */
export interface ModelConfig {
  codec: CodecTokens;
  tts: TtsTokens;
  chat: ChatTokens;
  languages: Map<string, number>;
  talker: TalkerParams;
  generation: SamplingDefaults;
  specialTokens: Map<string, number>;
}

// ── 预处理参数 ──

/** 预处理配置 */
export interface PreprocessingParams {
  paddingSide: string;
  paddingValue: number;
  processorClass: string;
  returnAttentionMask?: boolean;
}

// ── Fallback 默认值（registry 未初始化时使用） ──

export const FALLBACK_SAMPLING_DEFAULTS: SamplingDefaults = {
  doSample: true,
  temperature: 0.90,
  topK: 50,
  topP: 1.0,
  repetitionPenalty: 1.05,
  subDoSample: true,
  subTemperature: 0.9,
  subTopK: 50,
  subTopP: 1.0,
  maxNewTokens: 8192,
};

export const FALLBACK_PREPROCESSING: PreprocessingParams = {
  paddingSide: 'right',
  paddingValue: 0,
  processorClass: 'Qwen2Tokenizer',
  returnAttentionMask: false,
};

// ── 重导出 ──

export type { VdLanguageOption };
