import { OrtSessionManager } from '@/core/ortSessionManager';

/**
 * codec_embed.onnx 推理适配器
 *
 * ONNX I/O: codec_ids[1, T] int64 → codec_embeds[1, T, 2048] float32
 */
export class CodecEmbed {
  constructor(private sessionManager: OrtSessionManager) {}

  async embed(codecIds: Int32Array): Promise<Float32Array> {
    const result = await this.sessionManager.runInference<{
      success: boolean;
      data: Record<string, ArrayBuffer>;
    }>(
      'codec_embed',
      { codec_ids: new Int32Array(codecIds) },
      { codec_ids: [1, codecIds.length] },
      'synthesis',
    );

    if (!result?.success || !result.data) {
      throw new Error('codec_embed 推理失败');
    }
    const buf =
      result.data['codec_embeds'] ?? result.data[Object.keys(result.data)[0]];
    return new Float32Array(buf);
  }
}
