/**
 * src/core/encodingRegistry.ts — 编码配置全局注册表（单例）
 *
 * 在 App.tsx 加载模型目录后通过 loadConfigFromJSON 初始化。
 * 所有模块通过 encodingRegistry.getXxx() 获取运行时配置，
 * 替代原有的硬编码常量。
 */

import {
  ConfigError,
  type ModelConfig,
  type SamplingDefaults,
  type VdLanguageOption,
} from '@/types/encoding';

class EncodingRegistry {
  private config: ModelConfig | null = null;

  /** 初始化注册表。重复调用将抛出 ConfigError。 */
  initialize(config: ModelConfig): void {
    if (this.config) {
      throw new ConfigError('EncodingRegistry', '', 'Configuration already initialized');
    }
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

  // ── 架构固定值（与模型无关） ──

  /** tok_decoder 固定解码块帧数 */
  getDecoderFrames(): number {
    return 25;
  }

  /** 模型原生采样率 */
  getSampleRate(): number {
    return 24000;
  }
}

/** 全局单例 */
export const encodingRegistry = new EncodingRegistry();
