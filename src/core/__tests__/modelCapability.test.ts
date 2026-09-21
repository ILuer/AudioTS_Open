/**
 * modelCapability.test.ts — 模型能力契约的回归保护与解析行为
 *
 * 核心目的：钉死「默认契约 == 改造前的硬编码值」。
 * 任何人改动 QWEN3_TTS_VD_CAPABILITY 导致推理行为漂移，都会被这里的断言拦下。
 */
import { describe, it, expect } from 'vitest';
import {
  QWEN3_TTS_VD_CAPABILITY,
  buildKvInputNames,
  KV_NAME_BUILDERS,
  mergeCapability,
  parseCapabilityFromManifest,
  resolveCapability,
  sessionNameOf,
  modelFileOf,
  allModelFiles,
  hasRole,
} from '@/core/modelCapability';
import { SESSION_ROLES } from '@/types/capability';

describe('默认契约 = 改造前的硬编码值（回归保护）', () => {
  it('session 名与旧字面量逐一相等', () => {
    const C = QWEN3_TTS_VD_CAPABILITY;
    expect(sessionNameOf(C, 'textEmbed')).toBe('text_embed');
    expect(sessionNameOf(C, 'codecEmbed')).toBe('codec_embed');
    expect(sessionNameOf(C, 'talkerCache')).toBe('talker_cache');
    expect(sessionNameOf(C, 'codePredictor')).toBe('code_predictor');
    expect(sessionNameOf(C, 'residualEmbed')).toBe('residual_embed');
    expect(sessionNameOf(C, 'tokDecoder')).toBe('tok_decoder');
    expect(sessionNameOf(C, 'tokEncoder')).toBe('tok_encoder');
  });

  it('张量名与旧字面量逐一相等', () => {
    const io = QWEN3_TTS_VD_CAPABILITY.io;
    expect(io).toEqual({
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
    });
  });

  it('timing / 结构参数与旧常量相等', () => {
    const C = QWEN3_TTS_VD_CAPABILITY;
    expect(C.sampleRate).toBe(24_000);        // 旧 OUTPUT_SAMPLE_RATE / VD_SR
    expect(C.decoderFrames).toBe(25);         // 旧 DEC_FRAMES / VD_DEC_FRAMES
    expect(C.minFramesBeforeEos).toBe(5);     // 旧 MIN_FRAMES_BEFORE_EOS
    expect(C.maxFrames).toBe(500);            // 旧 AR 硬上限
    expect(C.numCodeGroups).toBe(16);
    expect(C.frameRate).toBe(12);
    expect(C.pipelineKind).toBe('qwen3-tts-vd');
  });

  it('tokenizer 路径与旧 BPE_*_PATH 常量相等', () => {
    expect(QWEN3_TTS_VD_CAPABILITY.tokenizer).toEqual({
      vocab: '/Models/vocab.json',
      merges: '/Models/merges.txt',
      config: '/Models/tokenizer_config.json',
    });
  });

  it('每个已声明角色的文件都是 .onnx', () => {
    for (const role of SESSION_ROLES) {
      const file = QWEN3_TTS_VD_CAPABILITY.sessions[role]?.file;
      if (!file) continue;
      expect(file.endsWith('.onnx')).toBe(true);
    }
  });
});

describe('KV 输入名生成器', () => {
  it('qwen3-tts-vd 约定复现旧 getPastNames() 的输出', () => {
    const names = buildKvInputNames(QWEN3_TTS_VD_CAPABILITY, 56);
    expect(names).toHaveLength(56);
    expect(names[0]).toBe('past_kv');
    expect(names[1]).toBe('past_kv_0_1');
    expect(names[2]).toBe('past_kv_1_0');
    expect(names[3]).toBe('past_kv_1_1');
    expect(names[54]).toBe('past_kv_27_0');
    expect(names[55]).toBe('past_kv_27_1');
    // 无重复
    expect(new Set(names).size).toBe(56);
  });

  it('canonical-kv 约定可用', () => {
    const names = KV_NAME_BUILDERS['canonical-kv'](4);
    expect(names).toEqual(['past_0_key', 'past_0_value', 'past_1_key', 'past_1_value']);
  });

  it('未知约定抛错并列出已注册项', () => {
    const cap = { ...QWEN3_TTS_VD_CAPABILITY, kvInputNaming: 'nope' };
    expect(() => buildKvInputNames(cap, 4)).toThrow(/未知的 KV 命名约定/);
  });

  it('生成数量与请求不符时抛错', () => {
    expect(() => buildKvInputNames(QWEN3_TTS_VD_CAPABILITY, 3)).toThrow(/期望 3/);
  });
});

describe('manifest capability 解析', () => {
  it('无 capability 段 → null（回落到内建契约）', () => {
    expect(parseCapabilityFromManifest('{"model_id":"Models"}')).toBeNull();
    expect(parseCapabilityFromManifest('')).toBeNull();
    expect(parseCapabilityFromManifest(undefined)).toBeNull();
    expect(parseCapabilityFromManifest(null)).toBeNull();
  });

  it('非法 JSON → null（不抛异常）', () => {
    expect(parseCapabilityFromManifest('{ not json')).toBeNull();
  });

  it('只提取声明过的字段', () => {
    const ov = parseCapabilityFromManifest(
      JSON.stringify({ capability: { sampleRate: 16000, unknownField: 'x' } }),
    );
    expect(ov).toEqual({ sampleRate: 16000 });
  });

  it('非法类型被忽略', () => {
    const ov = parseCapabilityFromManifest(
      JSON.stringify({ capability: { sampleRate: '16000', frameRate: 24 } }),
    );
    expect(ov).toEqual({ frameRate: 24 });
  });

  it('sessions 只接受已知角色且要求 file 字段', () => {
    const ov = parseCapabilityFromManifest(
      JSON.stringify({
        capability: {
          sessions: {
            tokDecoder: { file: 'vocoder.onnx', session: 'vocoder' },
            bogusRole: { file: 'x.onnx' },
            badEntry: 'not-an-object',
            noFile: { session: 'y' },
          },
        },
      }),
    );
    expect(ov?.sessions).toEqual({ tokDecoder: { file: 'vocoder.onnx', session: 'vocoder' } });
  });

  it('io 只接受已知语义键', () => {
    const ov = parseCapabilityFromManifest(
      JSON.stringify({ capability: { io: { waveform: 'audio_out', notAKey: 'z' } } }),
    );
    expect(ov?.io).toEqual({ waveform: 'audio_out' });
  });

  it('顶层平铺形式也能识别', () => {
    const ov = parseCapabilityFromManifest(JSON.stringify({ sampleRate: 48000 }));
    expect(ov).toEqual({ sampleRate: 48000 });
  });
});

describe('契约合并', () => {
  it('无覆盖时返回等价副本', () => {
    const merged = mergeCapability(QWEN3_TTS_VD_CAPABILITY);
    expect(merged).toEqual(QWEN3_TTS_VD_CAPABILITY);
    expect(merged.sessions).not.toBe(QWEN3_TTS_VD_CAPABILITY.sessions);
  });

  it('部分覆盖不影响其余字段', () => {
    const merged = resolveCapability(JSON.stringify({ capability: { sampleRate: 16000 } }));
    expect(merged.sampleRate).toBe(16000);
    expect(merged.decoderFrames).toBe(25);
    expect(merged.io.waveform).toBe('waveform');
  });

  it('sessions 局部覆盖按角色合并，未提及角色保持默认', () => {
    const merged = resolveCapability(
      JSON.stringify({ capability: { sessions: { tokDecoder: { file: 'vocoder.onnx' } } } }),
    );
    expect(modelFileOf(merged, 'tokDecoder')).toBe('vocoder.onnx');
    expect(sessionNameOf(merged, 'tokDecoder')).toBe('vocoder'); // 无 session 字段 → 由文件名推导
    expect(modelFileOf(merged, 'talkerCache')).toBe('talker_cache.onnx');
  });

  it('session 字段可显式覆盖', () => {
    const merged = resolveCapability(
      JSON.stringify({
        capability: { sessions: { talkerCache: { file: 'tc.onnx', session: 'talker_kv' } } },
      }),
    );
    expect(sessionNameOf(merged, 'talkerCache')).toBe('talker_kv');
  });

  it('可切换到另一条 pipelineKind 与另一套 KV 命名', () => {
    const merged = resolveCapability(
      JSON.stringify({
        capability: {
          pipelineKind: 'some-other-arch',
          kvInputNaming: 'canonical-kv',
          sampleRate: 22050,
        },
      }),
    );
    expect(merged.pipelineKind).toBe('some-other-arch');
    expect(buildKvInputNames(merged, 2)).toEqual(['past_0_key', 'past_0_value']);
  });
});

describe('查询辅助', () => {
  it('allModelFiles 覆盖全部角色', () => {
    const files = allModelFiles(QWEN3_TTS_VD_CAPABILITY);
    expect(files).toContain('talker_cache.onnx');
    expect(files).toHaveLength(SESSION_ROLES.length);
  });

  it('hasRole 反映声明状态', () => {
    expect(hasRole(QWEN3_TTS_VD_CAPABILITY, 'tokEncoder')).toBe(true);
    const stripped = mergeCapability(QWEN3_TTS_VD_CAPABILITY);
    delete (stripped.sessions as Record<string, unknown>).tokEncoder;
    expect(hasRole(stripped, 'tokEncoder')).toBe(false);
  });

  it('未声明的角色抛错', () => {
    const stripped = mergeCapability(QWEN3_TTS_VD_CAPABILITY);
    delete (stripped.sessions as Record<string, unknown>).talker;
    expect(() => sessionNameOf(stripped, 'talker')).toThrow(/未声明 session 角色/);
  });
});
