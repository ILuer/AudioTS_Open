/**
 * src/core/configLoader.ts — 配置文件解析器（纯函数，无副作用）
 *
 * 从磁盘 JSON 文件解析并归一化为标准化 ModelConfig。
 * 所有解析函数均为纯函数：输入原始字符串，输出类型化对象或抛出 ConfigError。
 */

import {
  ConfigError,
  type ModelConfig,
  type RawConfig,
  type RawTalkerConfig,
  type RawCodePredictorConfig,
  type RawGenerationConfig,
  type RawPreprocessorConfig,
  type RawTokenizerConfig,
  type SamplingDefaults,
} from '@/types/encoding';

// ── 默认值 ──

const DEFAULT_SAMPLING: SamplingDefaults = {
  doSample: true,
  temperature: 0.9,
  topK: 50,
  topP: 1.0,
  repetitionPenalty: 1.05,
  subDoSample: true,
  subTemperature: 0.9,
  subTopK: 50,
  subTopP: 1.0,
  maxNewTokens: 8192,
};

// ── 内部验证辅助 ──

function requireNumber(obj: Record<string, unknown>, key: string, file: string): number {
  const val = obj[key];
  if (val === undefined || val === null) {
    throw new ConfigError(file, key, `缺少必需字段`);
  }
  if (typeof val !== 'number') {
    throw new ConfigError(file, key, `期望 number，实际为 ${typeof val}`);
  }
  return val;
}

function requireString(obj: Record<string, unknown>, key: string, file: string): string {
  const val = obj[key];
  if (val === undefined || val === null) {
    throw new ConfigError(file, key, `缺少必需字段`);
  }
  if (typeof val !== 'string') {
    throw new ConfigError(file, key, `期望 string，实际为 ${typeof val}`);
  }
  return val;
}

function requireBoolean(obj: Record<string, unknown>, key: string, file: string): boolean {
  const val = obj[key];
  if (val === undefined || val === null) {
    throw new ConfigError(file, key, `缺少必需字段`);
  }
  if (typeof val !== 'boolean') {
    throw new ConfigError(file, key, `期望 boolean，实际为 ${typeof val}`);
  }
  return val;
}

function requireRecord(obj: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
  const val = obj[key];
  if (val === undefined || val === null) {
    throw new ConfigError(file, key, `缺少必需字段`);
  }
  if (typeof val !== 'object' || Array.isArray(val)) {
    throw new ConfigError(file, key, `期望 object，实际为 ${typeof val}`);
  }
  return val as Record<string, unknown>;
}

function requireStringArray(obj: Record<string, unknown>, key: string, file: string): string[] {
  const val = obj[key];
  if (val === undefined || val === null) {
    throw new ConfigError(file, key, `缺少必需字段`);
  }
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new ConfigError(file, key, `期望 string[]，实际为 ${typeof val}`);
  }
  return val as string[];
}

// ── 公开解析函数 ──

/** 解析 config.json 原始字符串 */
export function parseConfig(json: string): RawConfig {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new ConfigError('config.json', '', `JSON 解析失败: ${String(e)}`);
  }

  const architectures = requireStringArray(obj, 'architectures', 'config.json');
  const assistant_token_id = requireNumber(obj, 'assistant_token_id', 'config.json');
  const im_end_token_id = requireNumber(obj, 'im_end_token_id', 'config.json');
  const im_start_token_id = requireNumber(obj, 'im_start_token_id', 'config.json');
  const tts_bos_token_id = requireNumber(obj, 'tts_bos_token_id', 'config.json');
  const tts_eos_token_id = requireNumber(obj, 'tts_eos_token_id', 'config.json');
  const tts_pad_token_id = requireNumber(obj, 'tts_pad_token_id', 'config.json');
  const model_type = requireString(obj, 'model_type', 'config.json');
  const tokenizer_type = requireString(obj, 'tokenizer_type', 'config.json');
  const talkerRaw = requireRecord(obj, 'talker_config', 'config.json');

  const talker_config = parseTalkerConfig(talkerRaw);

  return {
    architectures,
    assistant_token_id,
    im_end_token_id,
    im_start_token_id,
    tts_bos_token_id,
    tts_eos_token_id,
    tts_pad_token_id,
    model_type,
    tokenizer_type,
    talker_config,
  };
}

/** 解析 talker_config 子结构 */
export function parseTalkerConfig(raw: Record<string, unknown>): RawTalkerConfig {
  const hidden_size = requireNumber(raw, 'hidden_size', 'config.json.talker_config');
  const vocab_size = requireNumber(raw, 'vocab_size', 'config.json.talker_config');
  const num_hidden_layers = requireNumber(raw, 'num_hidden_layers', 'config.json.talker_config');
  const num_attention_heads = requireNumber(raw, 'num_attention_heads', 'config.json.talker_config');
  const num_key_value_heads = requireNumber(raw, 'num_key_value_heads', 'config.json.talker_config');
  const num_code_groups = requireNumber(raw, 'num_code_groups', 'config.json.talker_config');
  const head_dim = requireNumber(raw, 'head_dim', 'config.json.talker_config');
  const codec_eos_token_id = requireNumber(raw, 'codec_eos_token_id', 'config.json.talker_config');
  const codec_pad_id = requireNumber(raw, 'codec_pad_id', 'config.json.talker_config');
  const codec_bos_id = requireNumber(raw, 'codec_bos_id', 'config.json.talker_config');
  const codec_think_id = requireNumber(raw, 'codec_think_id', 'config.json.talker_config');
  const codec_nothink_id = requireNumber(raw, 'codec_nothink_id', 'config.json.talker_config');
  const codec_think_bos_id = requireNumber(raw, 'codec_think_bos_id', 'config.json.talker_config');
  const codec_think_eos_id = requireNumber(raw, 'codec_think_eos_id', 'config.json.talker_config');
  const text_vocab_size = requireNumber(raw, 'text_vocab_size', 'config.json.talker_config');

  const codec_language_raw = requireRecord(raw, 'codec_language_id', 'config.json.talker_config');
  const codec_language_id: Record<string, number> = {};
  for (const [k, v] of Object.entries(codec_language_raw)) {
    if (typeof v !== 'number') {
      throw new ConfigError('config.json', `talker_config.codec_language_id.${k}`, `期望 number`);
    }
    codec_language_id[k] = v;
  }

  const codePredictorRaw = requireRecord(raw, 'code_predictor_config', 'config.json.talker_config');
  const code_predictor_config = parseCodePredictorConfig(codePredictorRaw);

  const tc: RawTalkerConfig = {
    hidden_size,
    vocab_size,
    num_hidden_layers,
    num_attention_heads,
    num_key_value_heads,
    num_code_groups,
    head_dim,
    codec_eos_token_id,
    codec_pad_id,
    codec_bos_id,
    codec_think_id,
    codec_nothink_id,
    codec_think_bos_id,
    codec_think_eos_id,
    codec_language_id,
    code_predictor_config,
    text_vocab_size,
  };

  if (raw.text_hidden_size !== undefined) {
    tc.text_hidden_size = raw.text_hidden_size as number;
  }
  if (raw.max_position_embeddings !== undefined) {
    tc.max_position_embeddings = raw.max_position_embeddings as number;
  }
  if (raw.position_id_per_seconds !== undefined) {
    tc.position_id_per_seconds = raw.position_id_per_seconds as number;
  }

  return tc;
}

/** 解析 code_predictor_config */
export function parseCodePredictorConfig(raw: Record<string, unknown>): RawCodePredictorConfig {
  const vocab_size = requireNumber(raw, 'vocab_size', 'config.json.talker_config.code_predictor_config');
  return { vocab_size };
}

/** 解析 generation_config.json */
export function parseGenerationConfig(json: string): RawGenerationConfig {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new ConfigError('generation_config.json', '', `JSON 解析失败: ${String(e)}`);
  }

  const do_sample = requireBoolean(obj, 'do_sample', 'generation_config.json');
  const temperature = requireNumber(obj, 'temperature', 'generation_config.json');
  const top_k = requireNumber(obj, 'top_k', 'generation_config.json');
  const top_p = requireNumber(obj, 'top_p', 'generation_config.json');
  const repetition_penalty = requireNumber(obj, 'repetition_penalty', 'generation_config.json');

  const cfg: RawGenerationConfig = {
    do_sample,
    temperature,
    top_k,
    top_p,
    repetition_penalty,
  };

  if (obj.subtalker_dosample !== undefined) cfg.subtalker_dosample = obj.subtalker_dosample as boolean;
  if (obj.subtalker_temperature !== undefined) cfg.subtalker_temperature = obj.subtalker_temperature as number;
  if (obj.subtalker_top_k !== undefined) cfg.subtalker_top_k = obj.subtalker_top_k as number;
  if (obj.subtalker_top_p !== undefined) cfg.subtalker_top_p = obj.subtalker_top_p as number;
  if (obj.max_new_tokens !== undefined) cfg.max_new_tokens = obj.max_new_tokens as number;

  return cfg;
}

/** 解析 preprocessor_config.json */
export function parsePreprocessorConfig(json: string): RawPreprocessorConfig {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new ConfigError('preprocessor_config.json', '', `JSON 解析失败: ${String(e)}`);
  }

  const padding_side = requireString(obj, 'padding_side', 'preprocessor_config.json');
  const padding_value = requireNumber(obj, 'padding_value', 'preprocessor_config.json');
  const processor_class = requireString(obj, 'processor_class', 'preprocessor_config.json');

  const cfg: RawPreprocessorConfig = { padding_side, padding_value, processor_class };
  if (obj.return_attention_mask !== undefined) {
    cfg.return_attention_mask = obj.return_attention_mask as boolean;
  }
  return cfg;
}

/** 解析 tokenizer_config.json */
export function parseTokenizerConfig(json: string): RawTokenizerConfig {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new ConfigError('tokenizer_config.json', '', `JSON 解析失败: ${String(e)}`);
  }

  const cfg: RawTokenizerConfig = {};

  if (obj.add_bos_token !== undefined) cfg.add_bos_token = obj.add_bos_token as boolean;
  if (obj.add_prefix_space !== undefined) cfg.add_prefix_space = obj.add_prefix_space as boolean;
  if (obj.added_tokens_decoder !== undefined && typeof obj.added_tokens_decoder === 'object') {
    cfg.added_tokens_decoder = obj.added_tokens_decoder as Record<string, Record<string, unknown>>;
  }

  return cfg;
}

/** 将 RawGenerationConfig 转换为 SamplingDefaults */
export function normalizeSampling(raw: RawGenerationConfig): SamplingDefaults {
  return {
    doSample: raw.do_sample,
    temperature: raw.temperature,
    topK: raw.top_k,
    topP: raw.top_p,
    repetitionPenalty: raw.repetition_penalty,
    // Propagate subtalker params for independent code predictor sampling
    subDoSample: raw.subtalker_dosample ?? true,
    subTemperature: raw.subtalker_temperature ?? 0.9,
    subTopK: raw.subtalker_top_k ?? 50,
    subTopP: raw.subtalker_top_p ?? 1.0,
    maxNewTokens: raw.max_new_tokens ?? 8192,
  };
}

// ── 上层聚合加载函数 ──

/**
 * 从文件映射加载并构建标准化 ModelConfig。
 *
 * @param files Map<filename, JSON string> — 从用户目录读取的文本文件内容
 * @returns 完整的 ModelConfig
 * @throws ConfigError 如果必需字段缺失
 */
export function loadConfigFromJSON(files: Map<string, string>): ModelConfig {
  // ── 必需: config.json ──
  const configRaw = files.get('config.json');
  if (!configRaw) {
    throw new ConfigError('config.json', '', '配置文件缺失，请确认模型目录包含 config.json');
  }
  const raw = parseConfig(configRaw);
  const tc = raw.talker_config;

  // ── 必需: tokenizer_config.json ──
  const tokenizerRaw = files.get('tokenizer_config.json');
  if (!tokenizerRaw) {
    throw new ConfigError('tokenizer_config.json', '', '分词器配置缺失');
  }
  const tokenizer = parseTokenizerConfig(tokenizerRaw);

  // ── 可选: generation_config.json ──
  let gen: SamplingDefaults = { ...DEFAULT_SAMPLING };
  const genRaw = files.get('generation_config.json');
  if (genRaw) {
    gen = normalizeSampling(parseGenerationConfig(genRaw));
  }

  // ── 验证必要子字段 ──
  if (!tc.codec_language_id || Object.keys(tc.codec_language_id).length === 0) {
    throw new ConfigError('config.json', 'talker_config.codec_language_id', '语言映射缺失或为空');
  }
  if (!tokenizer.added_tokens_decoder) {
    throw new ConfigError('tokenizer_config.json', 'added_tokens_decoder', '特殊 token 定义缺失');
  }

  // ── 从 added_tokens_decoder 构建 specialTokens ──
  const specialTokens = new Map<string, number>();
  for (const [idStr, entry] of Object.entries(tokenizer.added_tokens_decoder)) {
    if (entry && typeof entry === 'object' && 'content' in entry && typeof entry.content === 'string') {
      specialTokens.set(entry.content, parseInt(idStr, 10));
    }
  }

  // ── 构建标准化配置 ──
  const numLayers = tc.num_hidden_layers;
  const numKvHeads = tc.num_key_value_heads;

  return {
    codec: {
      eos: tc.codec_eos_token_id,
      pad: tc.codec_pad_id,
      bos: tc.codec_bos_id,
      think: tc.codec_think_id,
      nothink: tc.codec_nothink_id,
      thinkBos: tc.codec_think_bos_id,
      thinkEos: tc.codec_think_eos_id,
      vocabSize: tc.vocab_size,
      codePredictorVocabSize: tc.code_predictor_config?.vocab_size ?? 2048,
    },
    tts: {
      bos: raw.tts_bos_token_id,
      eos: raw.tts_eos_token_id,
      pad: raw.tts_pad_token_id,
    },
    chat: {
      imStart: raw.im_start_token_id,
      imEnd: raw.im_end_token_id,
      assistantId: raw.assistant_token_id,
    },
    languages: new Map(Object.entries(tc.codec_language_id)),
    talker: {
      hiddenSize: tc.hidden_size,
      numLayers,
      numKvHeads,
      headDim: tc.head_dim,
      numCodeGroups: tc.num_code_groups ?? 16,
      // ONNX past tensors: 2 per layer (key + value), GQA KV heads share the same cache
      numPastTensors: 2 * numLayers,
    },
    generation: gen,
    specialTokens,
  };
}
