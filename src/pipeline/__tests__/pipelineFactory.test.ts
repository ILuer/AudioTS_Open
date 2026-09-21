/**
 * pipelineFactory.test.ts — 管线实现可插拔（pipelineKind 分发）
 *
 * 这是「换一个 TTS 架构」的核心接线点：manifest 声明 pipelineKind，
 * 工厂据此选择实现类，调用方零改动。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createPipeline,
  createPipelineForActiveCapability,
  hasPipelineKind,
  listPipelineKinds,
  registerPipelineKind,
  type TtsPipeline,
} from '@/pipeline/pipelineFactory';
import { TtsPipelineV2 } from '@/pipeline/ttsPipelineV2';
import { activateCapabilityFromManifest, resetActiveCapability } from '@/core/modelRegistry';
import { QWEN3_TTS_VD_CAPABILITY } from '@/core/modelCapability';
import { AppError } from '@/types';

const fakeSm = {} as never;
const fakeTokenizer = {} as never;

afterEach(() => {
  resetActiveCapability();
});

describe('管线实现注册表', () => {
  it('内建 qwen3-tts-vd 已注册', () => {
    expect(hasPipelineKind('qwen3-tts-vd')).toBe(true);
    expect(listPipelineKinds()).toContain('qwen3-tts-vd');
  });

  it('按 kind 创建出 TtsPipelineV2 实例', () => {
    const p = createPipeline('qwen3-tts-vd', fakeSm, fakeTokenizer);
    expect(p).toBeInstanceOf(TtsPipelineV2);
    expect(typeof p.synthesize).toBe('function');
    expect(typeof p.destroy).toBe('function');
  });

  it('未注册的 kind 抛 PIPELINE_KIND_NOT_FOUND', () => {
    try {
      createPipeline('does-not-exist', fakeSm, fakeTokenizer);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('PIPELINE_KIND_NOT_FOUND');
      expect((err as AppError).message).toContain('qwen3-tts-vd');
    }
  });

  it('重复注册抛错，override 可覆盖', () => {
    expect(() => registerPipelineKind('qwen3-tts-vd', TtsPipelineV2)).toThrow(AppError);
    expect(() => registerPipelineKind('qwen3-tts-vd', TtsPipelineV2, { override: true })).not.toThrow();
  });
});

describe('按生效契约分发', () => {
  it('默认契约 → TtsPipelineV2，且注入的契约被实例持有', () => {
    const p = createPipelineForActiveCapability(fakeSm, fakeTokenizer) as TtsPipelineV2;
    expect(p).toBeInstanceOf(TtsPipelineV2);
    expect(p.capability).toEqual(QWEN3_TTS_VD_CAPABILITY);
  });

  it('manifest 声明新 pipelineKind 后，工厂改派到新实现', () => {
    class DummyPipeline implements TtsPipeline {
      readonly marker = 'dummy';
      constructor(
        public sm: unknown,
        public tokenizer: unknown,
        public options?: unknown,
      ) {}
      async synthesize(): Promise<{ pcm: Float32Array; wav: Blob; durationSec: number }> {
        return { pcm: new Float32Array(0), wav: new Blob(), durationSec: 0 };
      }
      async destroy(): Promise<void> {}
    }
    registerPipelineKind('dummy-arch', DummyPipeline as never, { override: true });

    activateCapabilityFromManifest(
      JSON.stringify({ capability: { pipelineKind: 'dummy-arch', sampleRate: 16000 } }),
    );

    const p = createPipelineForActiveCapability(fakeSm, fakeTokenizer);
    expect(p).toBeInstanceOf(DummyPipeline);
    // 契约一路透传到实现
    expect((p as unknown as { options: { capability: { sampleRate: number } } }).options.capability.sampleRate)
      .toBe(16000);
  });
});
