/**
 * src/hooks/useVoiceDesign.ts — VoiceDesign 合成工作流 Hook
 *
 * 流程：调参 → 合成试听。
 * 语音存储功能已移除（VoiceDesign 不再使用 IndexedDB 声纹存储）。
 *
 * 确定性：相同 params（含 seed）+ 相同文本 → AR 循环（mulberry32 PRNG + ORT CPU 确定性）→ 完全相同的 codes/waveform。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { OrtSessionManager } from '@/core/ortSessionManager';
import { Tokenizer } from '@/pipeline/tokenizer';
import { TtsPipelineV2 } from '@/pipeline/ttsPipelineV2';
import { eventBus, AppEvents } from '@/core/eventBus';
import { BPE_VOCAB_PATH, BPE_MERGES_PATH, BPE_CONFIG_PATH } from '@/core/constants';
import { AppError } from '@/types';
import type { SynthesisResult, SynthesisProgress, VoiceDesignParams } from '@/types';
import { logger } from '@/core/logger';

/** 合成工作流状态 */
export type VoiceDesignState = 'idle' | 'synthesizing' | 'complete' | 'error';

export interface UseVoiceDesignReturn {
  state: VoiceDesignState;
  progress: SynthesisProgress;
  result: SynthesisResult | null;
  error: string | null;
  /** 开始合成 */
  startSynthesis: (text: string, language: string, instruct: string, params: VoiceDesignParams) => Promise<void>;
  /** 重置工作流 */
  reset: () => void;
}

/**
 * VoiceDesign 合成工作流 Hook
 *
 * @param sessionManager ORT Session 管理器（VoiceDesign 集）。模型 buffer 已通过 setBuffers 注入，runInference 按需惰性加载。
 * @param buffersReady 模型 buffer 是否已注入
 */
export function useVoiceDesign(
  sessionManager: OrtSessionManager | null,
  buffersReady: boolean,
): UseVoiceDesignReturn {
  const [state, setState] = useState<VoiceDesignState>('idle');
  const [progress, setProgress] = useState<SynthesisProgress>({ stage: 'idle', percent: 0, message: '' });
  const [result, setResult] = useState<SynthesisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pipelineRef = useRef<TtsPipelineV2 | null>(null);
  const tokenizerRef = useRef<Tokenizer>(new Tokenizer());
  const lastParamsRef = useRef<VoiceDesignParams | null>(null);

  /** 初始化推理管线：BPE 加载 + pipeline 创建。模型按需惰性加载（runInference 自动 loadModel）。 */
  const ensurePipeline = useCallback(async (): Promise<TtsPipelineV2> => {
    if (!sessionManager) throw new AppError('INFERENCE_FAILED', 'SessionManager 未初始化');
    if (!sessionManager || !buffersReady) throw new AppError('INFERENCE_FAILED', '模型尚未全部加载完成');

    const tokenizer = tokenizerRef.current;
    if (!tokenizer.isLoaded()) {
      // BPE 数据由 App.tsx onConfigured 存入 window.__bpe_* 全局变量
      // (配置驱动改造后，config.json/generation_config.json 已通过 encodingRegistry 加载)
      const vocabData = (window as any).__bpe_vocab_json as string | undefined;
      const mergesData = (window as any).__bpe_merges_txt as string | undefined;
      const configData = (window as any).__bpe_tokenizer_config_json as string | undefined;
      if (vocabData && mergesData) {
        tokenizer.loadFromData(vocabData, mergesData, configData);
      } else {
        // Fallback: dev 模式下通过 URL 加载
        tokenizer.load(BPE_VOCAB_PATH, BPE_MERGES_PATH, BPE_CONFIG_PATH);
      }
    }

    if (!pipelineRef.current) pipelineRef.current = new TtsPipelineV2(sessionManager, tokenizer);
    return pipelineRef.current;
  }, [sessionManager, buffersReady]);

  // 改进依据: 状态盘点报告 P0-2 — 组件卸载时释放 GPU 资源
  // useEffect cleanup 在组件卸载时自动调用 pipeline.destroy()，
  // 释放 Worker 内所有 ONNX session，防止 GPU 显存累积泄漏。
  useEffect(() => {
    return () => {
      if (pipelineRef.current) {
        pipelineRef.current.destroy().catch(err =>
          logger.warn('[M3] destroy 失败:', err),
        );
        pipelineRef.current = null;
      }
    };
  }, []);

  /** 合成试听 */
  const startSynthesis = useCallback(
    async (text: string, language: string, instruct: string, params: VoiceDesignParams) => {
      if (!text.trim()) return;
      setState('synthesizing');
      setError(null);
      setProgress({ stage: 'synthesizing', percent: 0, message: '正在合成，请稍后。。。（0%）' });

      try {
        const pipeline = await ensurePipeline();
        lastParamsRef.current = params;

        const onProgress = (p: SynthesisProgress) => {
          setProgress(p);
          eventBus.emit(AppEvents.VOICE_DESIGN_PROGRESS, p);
        };

        onProgress({ stage: 'synthesizing', percent: 1, message: '正在合成，请稍后。。。（1%）' });
        const ttsOutput = await pipeline.synthesize({
          text,
          language,
          instruct,
          seed: params.seed,
          speed: params.speed,
          temperature: params.temperature,
          topK: params.topK,
          topP: params.topP,
          repetitionPenalty: params.repetitionPenalty,
          onProgress: (pct: number, msg: string) => {
            onProgress({ stage: 'synthesizing', percent: pct, message: msg });
          },
        });
        onProgress({ stage: 'synthesizing', percent: 95, message: '正在合成，请稍后。。。（95%）' });

        // 构建 SynthesisResult（V2 使用 pcm/wav/durationSec）
        const r: SynthesisResult = {
          success: true,
          pcmData: ttsOutput.pcm,
          wavBlob: ttsOutput.wav,
          durationSec: ttsOutput.durationSec,
          timing: {
            preprocessMs: 0,
            embeddingMs: 0,
            synthesisMs: 0,
            totalMs: 0,
          },
        };

        setResult(r);
        setState('complete');
        setProgress({ stage: 'complete', percent: 100, message: '合成完成' });
        eventBus.emit(AppEvents.VOICE_DESIGN_COMPLETE, r);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.error('[M3] 合成失败:', m);
        setState('error');
        setError(m);
        eventBus.emit(AppEvents.VOICE_DESIGN_ERROR, m);
      }
    },
    [ensurePipeline],
  );

  const reset = useCallback(() => {
    setState('idle');
    setProgress({ stage: 'idle', percent: 0, message: '' });
    setResult(null);
    setError(null);
    lastParamsRef.current = null;
    // 改进依据: 状态盘点报告 P0-2 — 重置时释放 GPU 资源
    if (pipelineRef.current) {
      pipelineRef.current.destroy().catch(err =>
        logger.warn('[M3] reset destroy 失败:', err),
      );
      pipelineRef.current = null;
    }
  }, []);

  return {
    state,
    progress,
    result,
    error,
    startSynthesis,
    reset,
  };
}
