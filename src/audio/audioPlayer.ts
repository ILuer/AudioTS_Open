/**
 * src/audio/audioPlayer.ts — WAV 播放器
 *
 * 通过 AudioContext 播放 WAV Blob。
 * AudioContext 延迟创建（首次 play 时），满足浏览器 autoplay 合规要求。
 *
 * 严格遵循 system_design_m3.md §T02 AudioPlayer 定义。
 *
 * T04: pcmToWavBlob 已迁移至 pipeline/audioOutput.ts；
 *      playPcm 改为委托 AudioOutput 转换后调用 playBlob。
 */

import { AudioOutput } from '@/pipeline/audioOutput';

/** AudioPlayer 实例类（需要持有持久 AudioContext） */
export class AudioPlayer {
  /** AudioContext 实例（延迟创建） */
  private audioContext: AudioContext | null = null;
  /** 当前播放的 AudioBufferSourceNode */
  private currentSource: AudioBufferSourceNode | null = null;
  /** 当前播放开始时间 */
  private startTime: number = 0;
  /** 当前播放的音频时长 */
  private currentDuration: number = 0;
  /** PCM→WAV 转换器（T04 迁移至此） */
  private audioOutput: AudioOutput = new AudioOutput();

  /**
   * 确保 AudioContext 已创建（用户手势触发）
   */
  private ensureContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    // 如果 AudioContext 被暂停（浏览器策略），尝试恢复
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    return this.audioContext;
  }

  /**
   * 播放 WAV Blob。
   *
   * @param wavBlob - audio/wav 格式的 Blob
   */
  async playBlob(wavBlob: Blob): Promise<void> {
    this.stop();
    const ctx = this.ensureContext();
    const arrayBuffer = await wavBlob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    this.currentSource = source;
    this.startTime = ctx.currentTime;
    this.currentDuration = audioBuffer.duration;
    source.onended = () => {
      if (this.currentSource === source) {
        this.currentSource = null;
      }
    };
    source.start(0);
  }

  /**
   * 播放 PCM 音频（委托 AudioOutput 转换后调用 playBlob）。
   *
   * @param pcm - Float32 PCM 数据 (-1.0 ~ 1.0)
   * @param sampleRate - 采样率 (Hz)
   */
  async playPcm(pcm: Float32Array, sampleRate: number): Promise<void> {
    const wavBlob = this.audioOutput.pcmToWavBlob(pcm, sampleRate);
    await this.playBlob(wavBlob);
  }

  /**
   * 停止当前播放
   */
  stop(): void {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // 可能已经停止，忽略
      }
      this.currentSource.disconnect();
      this.currentSource = null;
    }
  }

  /**
   * 获取 PCM 音频的时长（秒）
   *
   * @param pcm - PCM 数据
   * @param sampleRate - 采样率 (Hz)
   * @returns 时长（秒）
   */
  getDuration(pcm: Float32Array, sampleRate: number): number {
    return pcm.length / sampleRate;
  }

  /**
   * 获取当前播放进度 (0-1)
   */
  getProgress(): number {
    if (
      !this.audioContext ||
      !this.currentSource ||
      this.currentDuration <= 0
    ) {
      return 0;
    }
    const elapsed = this.audioContext.currentTime - this.startTime;
    return Math.min(1, Math.max(0, elapsed / this.currentDuration));
  }

  /**
   * 检查是否正在播放
   */
  isPlaying(): boolean {
    return this.currentSource !== null;
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.stop();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
