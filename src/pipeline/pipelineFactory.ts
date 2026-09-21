/**
 * src/pipeline/pipelineFactory.ts — 管线实现注册表（多模型可插拔的装配点）
 *
 * 模型架构与管线实现的对应关系由 `capability.pipelineKind` 决定：
 *   capability.pipelineKind = 'qwen3-tts-vd'  →  TtsPipelineV2
 *
 * 新增一个 TTS 架构时的工作流：
 *   1. 实现一个满足 TtsPipeline 接口的类
 *   2. registerPipelineKind('<kind>', YourPipeline)
 *   3. 在新模型集的 manifest.json 里声明 capability.pipelineKind = '<kind>'
 *   —— 调用方（useVoiceDesign / DubbingTab 等）无需任何改动
 */

import type { OrtSessionManager } from '@/core/ortSessionManager';
import { AppError } from '@/types';
import type { ModelCapability } from '@/types/capability';
import { getActiveCapability } from '@/core/modelRegistry';
import type { Tokenizer } from './tokenizer';
import { TtsPipelineV2, type TtsPipelineV2Options, type TtsSynthesisInput } from './ttsPipelineV2';

/** 管线统一接口 —— 调用方只依赖此接口，不依赖具体实现 */
export interface TtsPipeline {
  synthesize(input: TtsSynthesisInput): Promise<{ pcm: Float32Array; wav: Blob; durationSec: number }>;
  destroy(): Promise<void>;
}

export type TtsPipelineCtor = new (
  sm: OrtSessionManager,
  tokenizer: Tokenizer,
  options?: TtsPipelineV2Options,
) => TtsPipeline;

const implementations = new Map<string, TtsPipelineCtor>();

/** 注册管线实现 */
export function registerPipelineKind(
  kind: string,
  ctor: TtsPipelineCtor,
  options?: { override?: boolean },
): void {
  if (implementations.has(kind) && !options?.override) {
    throw new AppError('PIPELINE_KIND_DUPLICATE', `管线实现 '${kind}' 已注册`);
  }
  implementations.set(kind, ctor);
}

/** 是否已注册某管线实现 */
export function hasPipelineKind(kind: string): boolean {
  return implementations.has(kind);
}

/** 列出全部已注册管线实现 */
export function listPipelineKinds(): string[] {
  return Array.from(implementations.keys());
}

/**
 * 按 pipelineKind 创建管线实例。
 * 未注册的 kind 抛出 PIPELINE_KIND_NOT_FOUND，并在错误信息中列出可用实现。
 */
export function createPipeline(
  kind: string,
  sm: OrtSessionManager,
  tokenizer: Tokenizer,
  options?: TtsPipelineV2Options,
): TtsPipeline {
  const ctor = implementations.get(kind);
  if (!ctor) {
    throw new AppError(
      'PIPELINE_KIND_NOT_FOUND',
      `未注册的管线实现 '${kind}'；已注册: ${listPipelineKinds().join(', ') || '(空)'}`,
    );
  }
  return new ctor(sm, tokenizer, options);
}

/**
 * 按「当前生效契约」创建管线。
 * 这是 UI 层的标准入口：契约来自 manifest.json 的 capability 段。
 */
export function createPipelineForActiveCapability(
  sm: OrtSessionManager,
  tokenizer: Tokenizer,
  options?: Partial<TtsPipelineV2Options>,
): TtsPipeline {
  const capability: ModelCapability = options?.capability ?? getActiveCapability();
  return createPipeline(capability.pipelineKind, sm, tokenizer, { ...options, capability });
}

// ── 内建管线实现注册 ──

registerPipelineKind('qwen3-tts-vd', TtsPipelineV2);

export { TtsPipelineV2 };
