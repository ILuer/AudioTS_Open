/**
 * codec_embed.onnx 推理适配器
 *
 * ONNX I/O（Qwen3-TTS VoiceDesign 契约）:
 *   codec_ids[1, T] int64 → codec_embeds[1, T, 2048] float32
 *
 * 多模型可插拔改造（dev 分支）:
 *   session 名与张量名改由 ModelCapability 提供，不再内联字面量。
 */
import { OrtSessionManager } from '@/core/ortSessionManager';
import { sessionNameOf } from '@/core/modelCapability';
import { getActiveCapability } from '@/core/modelRegistry';
import type { ModelCapability } from '@/types/capability';

export class CodecEmbed {
  private cap: ModelCapability;

  constructor(
    private sessionManager: OrtSessionManager,
    capability?: ModelCapability,
  ) {
    this.cap = capability ?? getActiveCapability();
  }

  async embed(codecIds: Int32Array): Promise<Float32Array> {
    const io = this.cap.io;
    const result = await this.sessionManager.runInference<{
      success: boolean;
      data: Record<string, ArrayBuffer>;
    }>(
      sessionNameOf(this.cap, 'codecEmbed'),
      { [io.codecIds]: new Int32Array(codecIds) },
      { [io.codecIds]: [1, codecIds.length] },
      'synthesis',
    );

    if (!result?.success || !result.data) {
      throw new Error(`${sessionNameOf(this.cap, 'codecEmbed')} 推理失败`);
    }
    const buf =
      result.data[io.codecEmbeds] ?? result.data[Object.keys(result.data)[0]];
    return new Float32Array(buf);
  }
}
