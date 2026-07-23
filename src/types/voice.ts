/**
 * src/types/voice.ts — VoiceDesign 合成阶段与参数类型定义
 */

// ── 合成阶段与进度 ──

/** 合成阶段枚举 */
export type SynthesisStage =
  | 'idle'
  | 'uploading'
  | 'preprocessing'
  | 'embedding'
  | 'text_encoding'
  | 'codec_encoding'
  | 'talker_first_pass'
  | 'ar_loop'
  | 'synthesizing'
  | 'decoding'
  | 'complete'
  | 'confirmed'
  | 'error';

/** 合成进度 */
export interface SynthesisProgress {
  /** 当前阶段 */
  stage: SynthesisStage;
  /** 进度百分比 (0-100) */
  percent: number;
  /** 阶段描述信息 */
  message: string;
}

/** 各阶段计时 */
export interface StageTiming {
  /** 预处理耗时 (ms) */
  preprocessMs: number;
  /** 声纹提取耗时 (ms) */
  embeddingMs: number;
  /** 合成耗时 (ms) */
  synthesisMs: number;
  /** 总耗时 (ms) */
  totalMs: number;
}

/** 合成结果 */
export interface SynthesisResult {
  /** 是否成功 */
  success: boolean;
  /** 合成 PCM 数据（12kHz Float32Array） */
  pcmData: Float32Array;
  /** WAV Blob（可直接播放/下载） */
  wavBlob: Blob;
  /** 音频时长（秒） */
  durationSec: number;
  /** 声纹相似度（cos 值，可选） */
  similarityScore?: number;
  /** 错误信息（失败时有值） */
  error?: string;
  /** 各阶段耗时统计 */
  timing: StageTiming;
}

// ── 语种与模板 ──

/** 试听文本模板 */
export interface TextTemplate {
  /** 模板名称 */
  name: string;
  /** 模板文本 */
  text: string;
  /** 适用语种 */
  language: string;
}

// ── VoiceDesign 推理参数（参数全可视化，目标 1） ──

/** 参数控件类型 */
export type ParamType = 'number' | 'boolean' | 'select' | 'text' | 'slider';

/** 参数分组（用于 UI 分区渲染） */
export type ParamGroup = 'sampling' | 'generation' | 'audio' | 'model';

/** 语言选项（基于 config.json 的 codec_language_id 真实 token id） */
export interface VdLanguageOption {
  /** 语种代码（'Auto' 表示自动） */
  code: string;
  /** 显示标签 */
  label: string;
  /** 对应 codec language token id；-1 表示不注入（Auto） */
  tokenId: number;
}

/**
 * 单个推理参数的声明式描述（单一数据源，同时驱动 UI 与默认值）。
 * 详见 `src/inference/voiceDesignParams.ts` 的 `VOICE_DESIGN_PARAM_SPECS`。
 */
export interface VoiceDesignParamSpec {
  /** 与 VoiceDesignParams 键对齐 */
  name: keyof VoiceDesignParams;
  /** 中文显示名 */
  label: string;
  /** 控件类型 */
  type: ParamType;
  /** 分组（UI Section 标题） */
  group: ParamGroup;
  /** 便捷范围元组 [min, max]（number 用） */
  range?: [number, number];
  /** number 控件最小值 */
  min?: number;
  /** number 控件最大值 */
  max?: number;
  /** number 控件步长 */
  step?: number;
  /** 默认值 */
  default: unknown;
  /** select 控件选项（language 等） */
  options?: { value: string; label: string }[];
  /** 用途说明 */
  desc: string;
  /** true=模型固有只读，不在 UI 暴露 */
  internal: boolean;
  /** true=折叠在高级参数面板，false/undefined=始终显示在基础面板 */
  advanced?: boolean;
}

/**
 * VoiceDesign 最小可调参数（精简后仅 3 个用户可见参数）。
 *
 * 被移除的采样/生成参数已硬编码为 Python CLI 默认值：
 *   do_sample=true, top_k=50, top_p=1.0, temperature=0.9,
 *   repetition_penalty=1.05, sub_do_sample=true, sub_top_k=50,
 *   sub_top_p=1.0, sub_temperature=0.9, max_new_tokens=2048,
 *   ar_max_frames=500。
 */
export interface VoiceDesignParams {
  /** 随机种子（0-2147483647），相同种子 = 相同音色 */
  seed: number;
  /** 语种代码：'Auto' | 'chinese' | 'english' | ... */
  language: string;
  /** 风格指令文本（VoiceDesign 专属），例如"温柔的女声" */
  instruct: string;
  /** 语速倍率 0.5-2.0，默认 1.0 */
  speed: number;
  /** 发音随机性 0.80-1.00，默认 0.90。偏低更稳定但偏机械，偏高更自然但可能抖动 */
  temperature: number;
  /** AR 采样 top-k 截断，0=不截断，默认 20 */
  topK: number;
  /** AR 采样 nucleus 概率阈值 0.50-1.00，默认 0.85 */
  topP: number;
  /** 重复惩罚系数 1.00-2.00，默认 1.05 */
  repetitionPenalty: number;
}

// 注：ModelSet / ModelSetId 已统一在 src/core/modelSet.ts 定义，
// 并经 src/types/index.ts 汇总导出，本文件不再重复 re-export。

// ── 调音台：音色档案（原型 SEED_PROFILES + VoiceDesignParams 融合） ──

/**
 * 音色档案（调音台建档 + 配音台按角色名匹配）。
 * 持久化于 localStorage['audiots-profiles']（JSON，不含音频二进制）。
 */
export interface VoiceProfile {
  id: string;
  name: string;
  language: string; // 'Auto' | 'chinese' | 'english' | ...
  dialect: string | null; // 方言（非中文为 null）
  age: string; // 幼儿/儿童/少年/青年/中年/老年
  gender: string; // 女声/男声/中性声
  personality: string[]; // 个性标签
  instruct: string; // 自动拼接或手动编辑
  speed: number;
  seed: number;
  params: Pick<VoiceDesignParams, 'temperature' | 'topK' | 'topP' | 'repetitionPenalty'>;
  note: string;
  /** 参考音频文件名（仅记录，真实声纹建模于后续批次接入） */
  referenceAudio?: string | null;
}

// ── 配音台：台词行 ──

/** 配音台词行（配音台逐行合成 / 状态机使用） */
export interface ScriptRow {
  index: number;
  role: string; // 角色名
  emotion: string; // 情绪
  text: string; // 台词
  voiceId: string | null; // 关联音色档案 id
  voiceName: string | null;
  instruct: string | null;
  status: 'idle' | 'linked' | 'unlinked' | 'wait' | 'processing' | 'done' | 'failed';
  /** 合成进度百分比（0-100），仅 processing 态使用 */
  pct?: number;
  wavBlob?: Blob;
  durationSec?: number;
  error?: string;
}
