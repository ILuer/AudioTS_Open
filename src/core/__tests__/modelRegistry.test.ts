/**
 * modelRegistry.test.ts — 多模型集注册表 + 运行期契约切换
 *
 * 验证「新增一个模型集 / 新增一种管线实现」这条可插拔路径确实成立：
 * 注册 → 激活 → 从 manifest 覆盖 → 生效契约被管线读到。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  activateCapabilityFromManifest,
  capabilityOf,
  getActiveCapability,
  getActiveModelSetId,
  getActiveTokenizerFiles,
  getDefaultModelSet,
  getModelSet,
  hasModelSet,
  listModelSets,
  registerModelSet,
  resetActiveCapability,
  setActiveCapability,
} from '@/core/modelRegistry';
import { QWEN3_TTS_VD_CAPABILITY } from '@/core/modelCapability';
import { DEFAULT_MODEL_SET_ID, type ModelSet } from '@/core/modelSet';
import { AppError } from '@/types';

afterEach(() => {
  resetActiveCapability();
});

describe('模型集注册表', () => {
  it('内建 VoiceDesign 集已注册', () => {
    expect(hasModelSet(DEFAULT_MODEL_SET_ID)).toBe(true);
    expect(getDefaultModelSet().id).toBe('voicedesign');
  });

  it('未注册的 id 抛 MODEL_SET_NOT_FOUND 并列出可用项', () => {
    try {
      getModelSet('nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('MODEL_SET_NOT_FOUND');
      expect((err as AppError).message).toContain('voicedesign');
    }
  });

  it('重复注册抛错，override 可覆盖', () => {
    const dup: ModelSet = { ...getDefaultModelSet(), id: 'voicedesign' };
    expect(() => registerModelSet(dup)).toThrow(AppError);
    expect(() => registerModelSet(dup, { override: true })).not.toThrow();
  });

  it('可注册新模型集并出现在 list 中', () => {
    const custom: ModelSet = {
      id: 'custom-tts',
      label: 'Custom TTS',
      dir: 'Models/custom',
      files: [],
      manifestDriven: true,
      capability: { ...QWEN3_TTS_VD_CAPABILITY, pipelineKind: 'custom-arch', sampleRate: 22050 },
    };
    registerModelSet(custom, { override: true });
    expect(listModelSets().map((s) => s.id)).toContain('custom-tts');
    expect(capabilityOf(getModelSet('custom-tts')).sampleRate).toBe(22050);
  });

  it('未声明 capability 的模型集回落到默认契约', () => {
    const bare: ModelSet = {
      id: 'bare',
      label: 'Bare',
      dir: 'Models/bare',
      files: [],
      manifestDriven: false,
    };
    registerModelSet(bare, { override: true });
    expect(capabilityOf(getModelSet('bare'))).toEqual(QWEN3_TTS_VD_CAPABILITY);
  });
});

describe('运行期生效契约', () => {
  it('默认等于内建契约', () => {
    expect(getActiveCapability()).toEqual(QWEN3_TTS_VD_CAPABILITY);
    expect(getActiveModelSetId()).toBe('voicedesign');
  });

  it('无 manifest / 无 capability 段时回落默认契约', () => {
    expect(activateCapabilityFromManifest(null)).toEqual(QWEN3_TTS_VD_CAPABILITY);
    expect(activateCapabilityFromManifest('{"model_id":"x"}')).toEqual(QWEN3_TTS_VD_CAPABILITY);
    expect(activateCapabilityFromManifest('{ broken')).toEqual(QWEN3_TTS_VD_CAPABILITY);
  });

  it('manifest 的 capability 段生效', () => {
    const cap = activateCapabilityFromManifest(
      JSON.stringify({
        capability: { sampleRate: 16000, decoderFrames: 32, pipelineKind: 'custom-arch' },
      }),
    );
    expect(cap.sampleRate).toBe(16000);
    expect(cap.decoderFrames).toBe(32);
    expect(cap.pipelineKind).toBe('custom-arch');
    expect(getActiveCapability().pipelineKind).toBe('custom-arch');
  });

  it('tokenizer 路径随契约切换（替代 BPE_*_PATH 硬编码）', () => {
    activateCapabilityFromManifest(
      JSON.stringify({
        capability: { tokenizer: { vocab: '/Models/custom/vocab.json' } },
      }),
    );
    const files = getActiveTokenizerFiles();
    expect(files.vocab).toBe('/Models/custom/vocab.json');
    expect(files.merges).toBe('/Models/merges.txt'); // 未覆盖的保持默认
  });

  it('切换到其他模型集时以该集的基准契约为基础', () => {
    registerModelSet(
      {
        id: 's2',
        label: 'S2',
        dir: 'Models/s2',
        files: [],
        manifestDriven: true,
        capability: { ...QWEN3_TTS_VD_CAPABILITY, sampleRate: 22050 },
      },
      { override: true },
    );
    const cap = activateCapabilityFromManifest(
      JSON.stringify({ capability: { maxFrames: 100 } }),
      's2',
    );
    expect(cap.sampleRate).toBe(22050);
    expect(cap.maxFrames).toBe(100);
    expect(getActiveModelSetId()).toBe('s2');
  });

  it('setActiveCapability 直接注入', () => {
    setActiveCapability({ ...QWEN3_TTS_VD_CAPABILITY, sampleRate: 8000 }, 'voicedesign');
    expect(getActiveCapability().sampleRate).toBe(8000);
  });

  it('resetActiveCapability 复位', () => {
    activateCapabilityFromManifest(JSON.stringify({ capability: { sampleRate: 1 } }));
    resetActiveCapability();
    expect(getActiveCapability().sampleRate).toBe(24000);
    expect(getActiveModelSetId()).toBe('voicedesign');
  });
});
