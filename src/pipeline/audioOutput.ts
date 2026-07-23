/**
 * src/pipeline/audioOutput.ts — PCM → WAV 转换
 *
 * 将 Float32 PCM 数据转换为 RIFF WAV Blob（Int16 LE, Mono）。
 * 从 src/audio/audioPlayer.ts 的 pcmToWavBlob 方法迁移而来。
 *
 * 采样率通常传 OUTPUT_SAMPLE_RATE=24000（对齐 Python SR=24000）。
 */

import { WAV_HEADER_SIZE } from '@/core/constants';

export class AudioOutput {
  /**
   * Float32 PCM [-1, 1] → WAV Blob (Int16 LE, Mono)。
   *
   * @param pcm - Float32 PCM 数据，取值范围 [-1, 1]
   * @param sampleRate - 采样率（Hz），应传 OUTPUT_SAMPLE_RATE=24000
   * @returns audio/wav MIME 类型的 Blob
   */
  pcmToWavBlob(pcm: Float32Array, sampleRate: number): Blob {
    const numSamples = pcm.length;
    const dataSize = numSamples * 2; // Int16 = 2 bytes per sample
    const fileSize = WAV_HEADER_SIZE + dataSize;
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // ── RIFF Header (12 bytes) ──
    // "RIFF"
    view.setUint8(0, 0x52); // R
    view.setUint8(1, 0x49); // I
    view.setUint8(2, 0x46); // F
    view.setUint8(3, 0x46); // F
    // File size - 8
    view.setUint32(4, fileSize - 8, true);
    // "WAVE"
    view.setUint8(8, 0x57); // W
    view.setUint8(9, 0x41); // A
    view.setUint8(10, 0x56); // V
    view.setUint8(11, 0x45); // E

    // ── fmt Subchunk (24 bytes) ──
    // "fmt "
    view.setUint8(12, 0x66); // f
    view.setUint8(13, 0x6D); // m
    view.setUint8(14, 0x74); // t
    view.setUint8(15, 0x20); // (space)
    // Subchunk1Size = 16 (PCM)
    view.setUint32(16, 16, true);
    // AudioFormat = 1 (PCM)
    view.setUint16(20, 1, true);
    // NumChannels = 1 (Mono)
    view.setUint16(22, 1, true);
    // SampleRate
    view.setUint32(24, sampleRate, true);
    // ByteRate = SampleRate * NumChannels * BitsPerSample/8
    view.setUint32(28, sampleRate * 1 * 2, true);
    // BlockAlign = NumChannels * BitsPerSample/8
    view.setUint16(32, 2, true);
    // BitsPerSample = 16
    view.setUint16(34, 16, true);

    // ── data Subchunk (8 bytes header) ──
    // "data"
    view.setUint8(36, 0x64); // d
    view.setUint8(37, 0x61); // a
    view.setUint8(38, 0x74); // t
    view.setUint8(39, 0x61); // a
    // Subchunk2Size
    view.setUint32(40, dataSize, true);

    // ── PCM data (Int16 little-endian) ──
    let offset = WAV_HEADER_SIZE;
    for (let i = 0; i < numSamples; i++) {
      // Clamp to [-1, 1] and convert to Int16
      const clamped = Math.max(-1, Math.min(1, pcm[i]));
      const int16 = Math.max(
        -32768,
        Math.min(32767, Math.round(clamped * 32767)),
      );
      view.setInt16(offset, int16, true);
      offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }
}
