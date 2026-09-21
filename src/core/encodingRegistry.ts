/**
 * src/core/encodingRegistry.ts — 编码配置注册表
 *
 * 在 App.tsx 加载模型目录后通过 loadConfigFromJSON 初始化。
 * 所有模块通过 registry.getXxx() 获取运行时配置，替代原有的硬编码常量。
 *
 * 多模型可插拔改造（dev 分支）:
 *   - 由「全局单例」升级为「可多实例」：createEncodingRegistry() 工厂
 *   - configure() 幂等替换配置，支持切换 / 重新选择模型目录
 *     （原 initialize() 二次调用会抛 'already initialized'，切换模型必然踩到）
 *   - getActiveRegistry() / setActiveRegistry() 提供「当前生效配置」的装配点，
 *     默认指向全局单例，既有调用点零改动
 *   - 架构固定值 getDecoderFrames/getSampleRate 已迁出至 ModelCapability
 *     （decoderFrames / sampleRate），此处不再重复定义
 */

import {
  ConfigError,
  type ModelConfig,
  type SamplingDefaults,
  type VdLanguageOption,
} from '@/types/encoding';

export class EncodingRegistry {
  private config: ModelConfig | null = null;

  /**
   * 初始化注册表（仅允许一次）。
   * 重复调用将抛出 ConfigError —— 需要替换配置请用 configure()。
   */
  initialize(config: ModelConfig): void {
    if (this.config) {
      throw new ConfigError('EncodingRegistry', '', 'Configuration already initialized');
    }
    this.config = config;
  }

  /**
   * 设置 / 替换配置（幂等）。
   * 多模型切换、用户重新选择模型目录时使用。
   */
  configure(config: ModelConfig): void {
    this.config = config;
  }

  /** 是否已完成初始化 */
  isInitialized(): boolean {
    return this.config !== null;
  }

  /** 重置注册表（用于测试或重新加载） */
  reset(): void {
    this.config = null;
  }

  /** 内部访问器：确保已初始化 */
  private get cfg(): ModelConfig {
    if (!this.config) {
      throw new ConfigError('EncodingRegistry', '', 'Not initialized — call encodingRegistry.initialize() first');
    }
    return this.config;
  }

  // ── Codec token IDs ──

  getCodecEos(): number { return this.cfg.codec.eos; }
  getCodecPad(): number { return this.cfg.codec.pad; }
  getCodecBos(): number { return this.cfg.codec.bos; }
  getCodecThink(): number { return this.cfg.codec.think; }
  getCodecNothink(): number { return this.cfg.codec.nothink; }
  getCodecThinkBos(): number { return this.cfg.codec.thinkBos; }
  getCodecThinkEos(): number { return this.cfg.codec.thinkEos; }
  getCodecVocabSize(): number { return this.cfg.codec.vocabSize; }
  getCodePredictorVocabSize(): number { return this.cfg.codec.codePredictorVocabSize; }

  // ── TTS token IDs ──

  getTtsBos(): number { return this.cfg.tts.bos; }
  getTtsEos(): number { return this.cfg.tts.eos; }
  getTtsPad(): number { return this.cfg.tts.pad; }

  // ── Chat token IDs ──

  getChatImStart(): number { return this.cfg.chat.imStart; }
  getChatImEnd(): number { return this.cfg.chat.imEnd; }
  getAssistantTokenId(): number { return this.cfg.chat.assistantId; }

  // ── Talker 模型参数 ──

  getTalkerHiddenSize(): number { return this.cfg.talker.hiddenSize; }
  getNumLayers(): number { return this.cfg.talker.numLayers; }
  getNumKvHeads(): number { return this.cfg.talker.numKvHeads; }
  getHeadDim(): number { return this.cfg.talker.headDim; }
  getNumCodeGroups(): number { return this.cfg.talker.numCodeGroups; }
  getNumPastTensors(): number { return this.cfg.talker.numPastTensors; }

  // ── 语言列表 ──

  /** 获取所有支持的语言选项 */
  getLanguages(): VdLanguageOption[] {
    const names: Record<string, string> = {
      chinese: '中文',
      english: 'English',
      german: 'Deutsch',
      italian: 'Italiano',
      portuguese: 'Português',
      spanish: 'Español',
      japanese: '日本語',
      korean: '한국어',
      french: 'Français',
      russian: 'Русский',
    };

    const langs: VdLanguageOption[] = [];
    for (const [code, tokenId] of this.cfg.languages) {
      langs.push({
        code,
        label: names[code] || code,
        tokenId,
      });
    }
    return langs;
  }

  /** 通过语种 code 获取 token id */
  getLanguageTokenId(code: string): number {
    return this.cfg.languages.get(code) ?? -1;
  }

  // ── 采样参数 ──

  getSamplingDefaults(): SamplingDefaults {
    return this.cfg.generation;
  }

  getMaxNewTokens(): number { return this.cfg.generation.maxNewTokens; }

  getSubtalkerDoSample(): boolean { return this.cfg.generation.subDoSample; }
  getSubtalkerTemperature(): number { return this.cfg.generation.subTemperature; }
  getSubtalkerTopK(): number { return this.cfg.generation.subTopK; }
  getSubtalkerTopP(): number { return this.cfg.generation.subTopP; }

  // ── 特殊 token 查询 ──

  getSpecialTokenId(content: string): number | undefined {
    return this.cfg.specialTokens.get(content);
  }

  // ── 派生值 ──

  /** suppress 起始索引（code_predictor vocab 之后） */
  getSuppressStart(): number {
    return this.cfg.codec.codePredictorVocabSize;
  }
}

/** 创建独立的注册表实例（多模型集并行时每个模型集一份） */
export function createEncodingRegistry(config?: ModelConfig): EncodingRegistry {
  const reg = new EncodingRegistry();
  if (config) reg.configure(config);
  return reg;
}

/** 全局默认单例（向后兼容既有调用点） */
export const encodingRegistry = new EncodingRegistry();

let activeRegistry: EncodingRegistry = encodingRegistry;

/** 取当前生效的编码配置注册表 */
export function getActiveRegistry(): EncodingRegistry {
  return activeRegistry;
}

/** 设置当前生效的编码配置注册表（切换模型集时调用） */
export function setActiveRegistry(reg: EncodingRegistry): void {
  activeRegistry = reg;
}

/** 复位为全局默认单例（测试用） */
export function resetActiveRegistry(): void {
  activeRegistry = encodingRegistry;
}
