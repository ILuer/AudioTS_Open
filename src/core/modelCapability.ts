/**
 * src/core/modelCapability.ts — 模型能力描述符：默认值 / 解析 / 合并
 *
 * 纯函数模块，无副作用、无 fetch。调用方负责把 manifest.json 的文本传进来。
 *
 * 依赖方向: types/capability.ts ← 本文件 ← modelSet.ts ← modelRegistry.ts
 * （本文件不反向依赖 modelSet，避免循环引用）
 *
 * ── 如何接入一个新模型集（无需改任何管线代码） ──
 *
 * 在模型目录的 manifest.json 中追加 `capability` 段（只需写与默认值不同的字段）：
 *
 * ```jsonc
 * {
 *   "sub_models": { "talker": { "filename": "talker.onnx" }, ... },
 *   "capability": {
 *     "pipelineKind": "my-arch",        // 决定用哪个管线实现（需先 registerPipelineKind）
 *     "sampleRate": 22050,
 *     "frameRate": 25,
 *     "decoderFrames": 32,
 *     "kvInputNaming": "canonical-kv",  // 或自定义 builder，注册进 KV_NAME_BUILDERS
 *     "sessions": { "talkerCache": { "file": "tc.onnx", "session": "talker_kv" } },
 *     "io": { "waveform": "audio_out" }
 *   }
 * }
 * ```
 *
 * 未声明的字段一律沿用 QWEN3_TTS_VD_CAPABILITY 的默认值；
 * 完全没有 capability 段（如从 HuggingFace 直接下载的官方 manifest）时整体回落默认契约。
 * 注意：`Models/` 目录被 .gitignore 排除，因此仓库内不带 manifest 的能力段，
 * 终端用户拿到的第三方 manifest 走的就是这条回落路径。
 */

import {
  SESSION_ROLES,
  type CapabilityOverride,
  type ModelCapability,
  type SessionContract,
  type SessionRole,
  type TensorContract,
  type TokenizerFiles,
} from '@/types/capability';

// ── 内建默认契约：Qwen3-TTS-12Hz-1.7B-VoiceDesign (cpu_int4) ──
//
// 关键约束：本对象必须与改造前的硬编码值逐一相等。
// src/__tests__/modelCapability.test.ts 对其做回归断言，
// 任何人改动此处而导致行为漂移都会被测试拦下。

export const QWEN3_TTS_VD_CAPABILITY: ModelCapability = {
  version: 1,
  pipelineKind: 'qwen3-tts-vd',
  label: 'VoiceDesign 1.7B',

  sampleRate: 24_000,
  frameRate: 12,
  numCodeGroups: 16,
  decoderFrames: 25,
  minFramesBeforeEos: 5,
  maxFrames: 500,

  supportsInstruct: true,
  supportsVoiceClone: false,

  sessions: {
    textEmbed: { file: 'text_embed.onnx' },
    codecEmbed: { file: 'codec_embed.onnx' },
    talker: { file: 'talker.onnx' },
    talkerCache: { file: 'talker_cache.onnx' },
    codePredictor: { file: 'code_predictor.onnx' },
    residualEmbed: { file: 'residual_embed.onnx' },
    tokDecoder: { file: 'tok_decoder.onnx' },
    tokEncoder: { file: 'tok_encoder.onnx', required: false },
  },

  io: {
    textIds: 'text_ids',
    textEmbeds: 'text_embeds',
    codecIds: 'codec_ids',
    codecEmbeds: 'codec_embeds',
    inputsEmbeds: 'inputs_embeds',
    positionIds: 'position_ids',
    attentionMask: 'attention_mask',
    logits: 'logits_Q4',
    hiddenStates: 'hidden_states',
    talkerHidden: 'talker_hidden',
    groupLogits: 'group_logits',
    stepEmbed: 'step_embed',
    audioCodes: 'audio_codes',
    waveform: 'waveform',
  },

  kvInputNaming: 'qwen3-tts-vd',

  tokenizer: {
    vocab: '/Models/vocab.json',
    merges: '/Models/merges.txt',
    config: '/Models/tokenizer_config.json',
  },
};

// ── KV-cache 输入名生成器 ──
//
// 不同导出对 past/present 张量的命名习惯不同，这里按标识查表。
// 新增模型集时，若命名约定不在下表内，直接在此注册一个 builder 即可。

export const KV_NAME_BUILDERS: Record<string, (count: number) => string[]> = {
  /** Qwen3-TTS 导出约定：past_kv, past_kv_0_1, past_kv_{i}_0, past_kv_{i}_1 */
  'qwen3-tts-vd': (count: number): string[] => {
    const names = ['past_kv', 'past_kv_0_1'];
    for (let i = 1; i < count / 2; i++) {
      names.push(`past_kv_${i}_0`, `past_kv_${i}_1`);
    }
    return names;
  },
  /** 规范化的 key/value 约定：past_{i}_key, past_{i}_value */
  'canonical-kv': (count: number): string[] => {
    const names: string[] = [];
    for (let i = 0; i < count / 2; i++) {
      names.push(`past_${i}_key`, `past_${i}_value`);
    }
    return names;
  },
};

/** 按契约生成 KV-cache 输入张量名列表 */
export function buildKvInputNames(cap: ModelCapability, count: number): string[] {
  const builder = KV_NAME_BUILDERS[cap.kvInputNaming];
  if (!builder) {
    throw new Error(
      `[capability] 未知的 KV 命名约定 '${cap.kvInputNaming}'；` +
        `已注册: ${Object.keys(KV_NAME_BUILDERS).join(', ')}`,
    );
  }
  const names = builder(count);
  if (names.length !== count) {
    throw new Error(
      `[capability] KV 命名约定 '${cap.kvInputNaming}' 生成 ${names.length} 个名字，期望 ${count}`,
    );
  }
  return names;
}

// ── 查询辅助 ──

/** 取某角色的 session 名（缺省 = 文件名去 .onnx） */
export function sessionNameOf(cap: ModelCapability, role: SessionRole): string {
  const c = cap.sessions[role];
  if (!c) throw new Error(`[capability] 未声明 session 角色 '${role}'`);
  return c.session ?? c.file.replace(/\.onnx$/, '');
}

/** 取某角色的 ONNX 文件名 */
export function modelFileOf(cap: ModelCapability, role: SessionRole): string {
  const c = cap.sessions[role];
  if (!c) throw new Error(`[capability] 未声明 session 角色 '${role}'`);
  return c.file;
}

/** 按角色收集全部模型文件名 */
export function allModelFiles(cap: ModelCapability): string[] {
  return SESSION_ROLES.map((r) => cap.sessions[r]?.file).filter((f): f is string => !!f);
}

/** 该契约是否声明了某角色（用于可选支路判断） */
export function hasRole(cap: ModelCapability, role: SessionRole): boolean {
  return !!cap.sessions[role];
}

// ── 合并 ──

/** 浅合并一层子对象，忽略 undefined */
function mergeSub<T extends object>(base: T, override?: Partial<T>): T {
  if (!override) return { ...base };
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/**
 * 把覆盖段合并到基准契约上，得到完整契约。
 * 所有子对象逐层合并；未声明的字段沿用基准值。
 */
export function mergeCapability(
  base: ModelCapability,
  override?: CapabilityOverride | null,
): ModelCapability {
  if (!override) return { ...base, sessions: { ...base.sessions }, io: { ...base.io }, tokenizer: { ...base.tokenizer } };

  const sessions = { ...base.sessions };
  if (override.sessions) {
    for (const [role, contract] of Object.entries(override.sessions)) {
      if (!contract) continue;
      const key = role as SessionRole;
      const prev: SessionContract | undefined = base.sessions[key];
      sessions[key] = prev ? { ...prev, ...contract } : (contract as SessionContract);
    }
  }

  return {
    ...base,
    ...(override.version !== undefined ? { version: override.version } : {}),
    ...(override.pipelineKind !== undefined ? { pipelineKind: override.pipelineKind } : {}),
    ...(override.label !== undefined ? { label: override.label } : {}),
    ...(override.sampleRate !== undefined ? { sampleRate: override.sampleRate } : {}),
    ...(override.frameRate !== undefined ? { frameRate: override.frameRate } : {}),
    ...(override.numCodeGroups !== undefined ? { numCodeGroups: override.numCodeGroups } : {}),
    ...(override.decoderFrames !== undefined ? { decoderFrames: override.decoderFrames } : {}),
    ...(override.minFramesBeforeEos !== undefined
      ? { minFramesBeforeEos: override.minFramesBeforeEos }
      : {}),
    ...(override.maxFrames !== undefined ? { maxFrames: override.maxFrames } : {}),
    ...(override.supportsInstruct !== undefined
      ? { supportsInstruct: override.supportsInstruct }
      : {}),
    ...(override.supportsVoiceClone !== undefined
      ? { supportsVoiceClone: override.supportsVoiceClone }
      : {}),
    ...(override.kvInputNaming !== undefined ? { kvInputNaming: override.kvInputNaming } : {}),
    sessions,
    io: mergeSub<TensorContract>(base.io, override.io),
    tokenizer: mergeSub<TokenizerFiles>(base.tokenizer, override.tokenizer),
  };
}

// ── manifest.json 解析 ──

/**
 * 从 manifest.json 文本中提取 capability 覆盖段。
 *
 * 兼容三种形态：
 *   1. `{ "capability": { ... } }`  —— 推荐
 *   2. 顶层平铺的 capability 字段（旧式/手写清单）
 *   3. 无 capability 段 —— 返回 null，调用方回落到内建默认契约
 *
 * 解析失败不抛异常（manifest 可能是用户从 HF 下载的第三方文件），
 * 只返回 null 并让调用方使用默认契约。
 */
export function parseCapabilityFromManifest(json: string | undefined | null): CapabilityOverride | null {
  if (!json) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const raw = (obj.capability ?? obj) as Record<string, unknown>;
  const out: CapabilityOverride = {};
  let touched = false;

  const num = (key: string): void => {
    const v = raw[key];
    if (typeof v === 'number') {
      (out as Record<string, unknown>)[key] = v;
      touched = true;
    }
  };
  const bool = (key: string): void => {
    const v = raw[key];
    if (typeof v === 'boolean') {
      (out as Record<string, unknown>)[key] = v;
      touched = true;
    }
  };
  const str = (key: string): void => {
    const v = raw[key];
    if (typeof v === 'string') {
      (out as Record<string, unknown>)[key] = v;
      touched = true;
    }
  };

  num('version');
  str('pipelineKind');
  str('label');
  num('sampleRate');
  num('frameRate');
  num('numCodeGroups');
  num('decoderFrames');
  num('minFramesBeforeEos');
  num('maxFrames');
  bool('supportsInstruct');
  bool('supportsVoiceClone');
  str('kvInputNaming');

  // sessions: { role: { file, session?, required? } }
  if (raw.sessions && typeof raw.sessions === 'object') {
    const sessions: Partial<Record<SessionRole, SessionContract>> = {};
    for (const [role, val] of Object.entries(raw.sessions as Record<string, unknown>)) {
      if (!SESSION_ROLES.includes(role as SessionRole)) continue;
      if (!val || typeof val !== 'object') continue;
      const v = val as Record<string, unknown>;
      if (typeof v.file !== 'string') continue;
      sessions[role as SessionRole] = {
        file: v.file,
        ...(typeof v.session === 'string' ? { session: v.session } : {}),
        ...(typeof v.required === 'boolean' ? { required: v.required } : {}),
      };
    }
    if (Object.keys(sessions).length > 0) {
      out.sessions = sessions;
      touched = true;
    }
  }

  // io: 只接受已知语义键
  if (raw.io && typeof raw.io === 'object') {
    const io: Partial<TensorContract> = {};
    const known = Object.keys(QWEN3_TTS_VD_CAPABILITY.io) as (keyof TensorContract)[];
    for (const [k, v] of Object.entries(raw.io as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      if (!known.includes(k as keyof TensorContract)) continue;
      io[k as keyof TensorContract] = v;
    }
    if (Object.keys(io).length > 0) {
      out.io = io;
      touched = true;
    }
  }

  // tokenizer
  if (raw.tokenizer && typeof raw.tokenizer === 'object') {
    const tk: Partial<TokenizerFiles> = {};
    for (const k of ['vocab', 'merges', 'config'] as const) {
      const v = (raw.tokenizer as Record<string, unknown>)[k];
      if (typeof v === 'string') tk[k] = v;
    }
    if (Object.keys(tk).length > 0) {
      out.tokenizer = tk;
      touched = true;
    }
  }

  return touched ? out : null;
}

/** 便捷入口：manifest 文本 → 完整契约（解析失败/无 capability 段则返回默认） */
export function resolveCapability(
  manifestJson?: string | null,
  base: ModelCapability = QWEN3_TTS_VD_CAPABILITY,
): ModelCapability {
  return mergeCapability(base, parseCapabilityFromManifest(manifestJson));
}
