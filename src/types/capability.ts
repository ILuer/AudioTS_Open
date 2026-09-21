/**
 * src/types/capability.ts — 模型能力描述符（Model Capability Descriptor）
 *
 * 设计目标（多模型可插拔改造）:
 *   把「某个模型集长什么样」从代码里挪到数据里。管线的全部结构信息
 *   —— session 名、ONNX 张量名、帧率、解码块帧数、KV 输入命名约定、
 *   tokenizer 文件位置——统一由 ModelCapability 描述。
 *
 *   换模型 = 换一份 capability（manifest.json 的 `capability` 段），
 *   而非改 ttsPipelineV2.ts 里的字面量。
 *
 * 分层:
 *   types/capability.ts      纯类型（无依赖）
 *   core/modelCapability.ts  默认值 + manifest 解析 + 合并
 *   core/modelRegistry.ts    多模型集注册表 + 当前生效契约
 */

/** 管线实现标识 —— 决定由哪个 pipeline 实现类承担推理 */
export type PipelineKind = 'qwen3-tts-vd';

/** 模型集内的逻辑角色（管线引用的键，与文件名解耦） */
export const SESSION_ROLES = [
  'textEmbed',
  'codecEmbed',
  'talker',
  'talkerCache',
  'codePredictor',
  'residualEmbed',
  'tokDecoder',
  'tokEncoder',
] as const;

export type SessionRole = (typeof SESSION_ROLES)[number];

/** 单个 session 的文件/名称契约 */
export interface SessionContract {
  /** ONNX 文件名（含 .onnx） */
  file: string;
  /**
   * Worker 内注册的 session 名。
   * 缺省时由文件名去掉 `.onnx` 推导（modelNameFromFile）。
   */
  session?: string;
  /** 是否为必需文件。缺省 true；tokEncoder 等按需支路为 false */
  required?: boolean;
}

/**
 * 张量名契约（语义键 → ONNX 实际张量名）。
 *
 * 语义键是管线内部使用的逻辑名；值是模型导出时决定的真实张量名。
 * 例：`textIds: 'text_ids'` 表示 text_embed 的输入张量名为 `text_ids`。
 */
export interface TensorContract {
  /** text_embed 输入：文本 token id */
  textIds: string;
  /** text_embed 输出：文本嵌入 */
  textEmbeds: string;
  /** codec_embed / code_predictor / residual_embed 输入：codec id */
  codecIds: string;
  /** codec_embed 输出：codec 嵌入 */
  codecEmbeds: string;
  /** talker 输入：拼接后的嵌入序列 */
  inputsEmbeds: string;
  /** talker 输入：位置编码 */
  positionIds: string;
  /** talker 输入：注意力掩码 */
  attentionMask: string;
  /** talker/talker_cache 输出：首码本 logits */
  logits: string;
  /** talker/talker_cache 输出：隐藏态 */
  hiddenStates: string;
  /** code_predictor 输入：talker 隐藏态 */
  talkerHidden: string;
  /** code_predictor 输出：15 组残余码本 logits */
  groupLogits: string;
  /** residual_embed 输出：单步残差嵌入 */
  stepEmbed: string;
  /** tok_decoder 输入：audio codes */
  audioCodes: string;
  /** tok_decoder 输出：波形 */
  waveform: string;
}

/** tokenizer 文件位置（相对项目根） */
export interface TokenizerFiles {
  vocab: string;
  merges: string;
  config: string;
}

/**
 * 模型能力描述符。
 *
 * 全部字段均有内建默认值（见 core/modelCapability.ts 的
 * QWEN3_TTS_VD_CAPABILITY），因此 manifest.json 只需声明差异部分。
 */
export interface ModelCapability {
  /** 描述符版本，用于后续兼容性判断 */
  version: number;
  /** 管线实现标识 */
  pipelineKind: PipelineKind | string;
  /** 人类可读标签（UI 展示用） */
  label: string;
  /** 输出采样率 (Hz) */
  sampleRate: number;
  /** 音频帧率 (frame/s)；Qwen3-TTS 为 12Hz */
  frameRate: number;
  /** 每帧 codec 码本组数 */
  numCodeGroups: number;
  /** 解码器固定块帧数（tok_decoder 的固定输入帧数） */
  decoderFrames: number;
  /** EOS 前的最小帧数（防吞词） */
  minFramesBeforeEos: number;
  /** AR 循环硬上限帧数 */
  maxFrames: number;
  /** 是否支持 instruct（音色设计描述） */
  supportsInstruct: boolean;
  /** 是否支持参考音频音色克隆 */
  supportsVoiceClone: boolean;
  /** session 契约表 */
  sessions: Record<SessionRole, SessionContract>;
  /** 张量名契约 */
  io: TensorContract;
  /** KV-cache 输入张量命名约定标识（见 core/modelCapability.ts 的 KV_NAME_BUILDERS） */
  kvInputNaming: string;
  /** tokenizer 文件位置 */
  tokenizer: TokenizerFiles;
}

/** manifest.json 中可声明的 capability 覆盖段（全部字段可选） */
export type CapabilityOverride = {
  [K in keyof ModelCapability]?: K extends 'sessions'
    ? Partial<Record<SessionRole, SessionContract>>
    : K extends 'io'
      ? Partial<TensorContract>
      : K extends 'tokenizer'
        ? Partial<TokenizerFiles>
        : ModelCapability[K];
};
