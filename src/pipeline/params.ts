/**
 * src/pipeline/params.ts — VoiceDesign 推理参数 schema（单一数据源）
 *
 * 精简后仅暴露 3 个用户可见基础参数 + 5 个高级参数。
 * 其余采样/生成参数已硬编码为 Python CLI 默认值。
 *
 * 配置驱动改造（2025-07-14）:
 *   语言 token id 权威来源: config.json 的 codec_language_id → encodingRegistry.getLanguages()
 *   采样默认值权威来源: generation_config.json → encodingRegistry.getSamplingDefaults()
 */

import type { VoiceDesignParamSpec, VoiceDesignParams, VdLanguageOption } from '@/types';
import { encodingRegistry } from '@/core/encodingRegistry';

/**
 * 构建语言选项列表。从 encodingRegistry 动态获取，前置 Auto 选项。
 * - 'Auto'（tokenId=-1）：不注入具体语种，走 codec /nothink 标签序列。
 * - 其余：注入对应 codec language token id。
 */
export function buildVdLanguages(): VdLanguageOption[] {
  const registered = encodingRegistry.isInitialized()
    ? encodingRegistry.getLanguages()
    : [];
  return [
    { code: 'Auto', label: '自动 (Auto)', tokenId: -1 },
    ...registered,
  ];
}

/**
 * @deprecated 使用 buildVdLanguages() 替代。保留导出以兼容旧引用。
 * 语言选项列表（运行时从 encodingRegistry 构建，含 Auto 前置）。
 */
export const VOICE_DESIGN_LANGUAGES: VdLanguageOption[] = buildVdLanguages();

/** 通过语种 code 获取真实 token id（Auto 返回 -1）。委托给 encodingRegistry。 */
export function getVdLanguageTokenId(code: string): number {
  if (code === 'Auto') return -1;
  return encodingRegistry.getLanguageTokenId(code);
}

/**
 * 参数声明列表（驱动 UI 与默认值）。
 *
 * 基础参数（始终可见）：instruct, speed, seed
 * 高级参数（折叠展开）：language, temperature, topK, topP, repetitionPenalty
 */
export const VOICE_DESIGN_PARAM_SPECS: VoiceDesignParamSpec[] = [
  {
    name: 'language',
    label: '语言',
    type: 'select',
    group: 'generation',
    default: 'Auto',
    options: buildVdLanguages().map((l) => ({ value: l.code, label: l.label })),
    desc: '选择说话的语言，选"自动"由模型自行判断。不同语言会影响发音风格和自然度。',
    internal: false,
    advanced: true,
  },
  {
    name: 'instruct',
    label: '风格描述',
    type: 'text',
    group: 'generation',
    default: '',
    desc: '用日常语言描述想要的声音风格，例如"温柔的女声""沉稳的男声""活泼的少年"。留空则用默认风格。这是决定音色最直接的方式。',
    internal: false,
    advanced: false,
  },
  {
    name: 'seed',
    label: '随机种子',
    type: 'number',
    group: 'generation',
    min: 0,
    max: 9999,
    step: 1,
    range: [0, 9999],
    default: 0,
    desc: '相同种子 + 相同设置 = 完全相同的声音。换个种子换个声音变体。',
    internal: false,
    advanced: false,
  },
  {
    name: 'speed',
    label: '语速',
    type: 'slider',
    group: 'generation',
    min: 0.50,
    max: 1.60,
    step: 0.01,
    default: 1.00,
    desc: '语速倍率。建议 0.81-1.20（绿色），0.50-0.80 和 1.21-1.40 偏慢/偏快（橙色），1.41-1.60 极端速度（红色）。',
    internal: false,
    advanced: false,
  },
  {
    name: 'temperature',
    label: '温度',
    type: 'slider',
    group: 'generation',
    min: 0.80,
    max: 1.00,
    step: 0.01,
    default: encodingRegistry.isInitialized()
      ? encodingRegistry.getSamplingDefaults().temperature
      : 0.9,
    desc: '控制发音随机性。偏低更稳定但偏机械，偏高更自然但可能抖动。推荐 0.85-0.95。',
    internal: false,
    advanced: true,
  },
  {
    name: 'topK',
    label: 'Top-K',
    type: 'slider',
    group: 'sampling',
    min: 0,
    max: 100,
    step: 1,
    default: encodingRegistry.isInitialized()
      ? encodingRegistry.getSamplingDefaults().topK
      : 50,
    desc: '每步采样时仅保留概率最高的 K 个 token。K=0 不截断（更随机），K 越小越稳定但可能机械。',
    internal: false,
    advanced: true,
  },
  {
    name: 'topP',
    label: 'Top-P',
    type: 'slider',
    group: 'sampling',
    min: 0.50,
    max: 1.00,
    step: 0.01,
    default: encodingRegistry.isInitialized()
      ? encodingRegistry.getSamplingDefaults().topP
      : 1.0,
    desc: '核采样阈值：从高到低累加 token 概率，超过该值后截断尾部。1.0=不截断，越低越保守。',
    internal: false,
    advanced: true,
  },
  {
    name: 'repetitionPenalty',
    label: '重复惩罚',
    type: 'slider',
    group: 'sampling',
    min: 1.00,
    max: 2.00,
    step: 0.01,
    default: encodingRegistry.isInitialized()
      ? encodingRegistry.getSamplingDefaults().repetitionPenalty
      : 1.05,
    desc: '对已生成的 token 施加惩罚。1.0=不惩罚，值越大越避免重复。过高会导致发音异常。',
    internal: false,
    advanced: true,
  },
];

/** 全部参数的默认值。采样参数从 encodingRegistry 动态获取（来自 generation_config.json）。 */
export const DEFAULT_VOICE_DESIGN_PARAMS: VoiceDesignParams = (() => {
  const sampling = encodingRegistry.isInitialized()
    ? encodingRegistry.getSamplingDefaults()
    : { temperature: 0.90, topK: 50, topP: 1.0, repetitionPenalty: 1.05 };
  return {
    seed: 0,
    language: 'Auto',
    instruct: '',
    speed: 1.00,
    temperature: sampling.temperature,
    topK: sampling.topK,
    topP: sampling.topP,
    repetitionPenalty: sampling.repetitionPenalty,
  };
})();

/** 深拷贝默认参数（避免调用方共享同一对象） */
export function cloneDefaultVoiceDesignParams(): VoiceDesignParams {
  return { ...DEFAULT_VOICE_DESIGN_PARAMS };
}
