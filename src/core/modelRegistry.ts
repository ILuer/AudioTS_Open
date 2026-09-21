/**
 * src/core/modelRegistry.ts — 多模型集注册表 + 运行期生效契约
 *
 * 这是「多模型可插拔」的装配点：
 *   - 模型集注册表：id → ModelSet（含文件清单与能力契约）
 *   - 运行期生效契约：manifest.json 解析出的 capability 覆盖段 + 模型集基准契约
 *
 * 运行期数据流（App → 管线）:
 *   用户在模型目录弹窗选中目录
 *     → textMap 中的 manifest.json
 *     → resolveCapability(manifestJson, setCapability)
 *     → setActiveCapability(cap)
 *     → pipelineFactory.createPipeline(cap.pipelineKind, ...) 读取生效契约
 *
 * 无循环依赖: types/capability ← modelCapability ← modelSet ← modelRegistry
 */

import { AppError } from '@/types';
import type { ModelCapability, TokenizerFiles } from '@/types/capability';
import {
  QWEN3_TTS_VD_CAPABILITY,
  mergeCapability,
  parseCapabilityFromManifest,
} from '@/core/modelCapability';
import {
  DEFAULT_MODEL_SET_ID,
  VOICEDESIGN_MODEL_SET,
  type ModelSet,
  type ModelSetId,
} from '@/core/modelSet';

// ── 模型集注册表 ──

const registry = new Map<ModelSetId, ModelSet>();

/**
 * 注册模型集。
 * @param set 模型集定义
 * @param options.override 已存在时是否覆盖（默认 false，重复注册抛错以暴露配置失误）
 */
export function registerModelSet(set: ModelSet, options?: { override?: boolean }): void {
  if (registry.has(set.id) && !options?.override) {
    throw new AppError('MODEL_SET_DUPLICATE', `模型集 '${set.id}' 已注册`);
  }
  // 未显式声明契约的模型集回落到默认契约（保证向后兼容）
  registry.set(set.id, { ...set, capability: set.capability ?? QWEN3_TTS_VD_CAPABILITY });
}

/** 查询模型集；不存在时抛 MODEL_SET_NOT_FOUND */
export function getModelSet(id: ModelSetId): ModelSet {
  const set = registry.get(id);
  if (!set) {
    throw new AppError(
      'MODEL_SET_NOT_FOUND',
      `未注册的模型集 '${id}'；已注册: ${Array.from(registry.keys()).join(', ')}`,
    );
  }
  return set;
}

/** 模型集是否存在 */
export function hasModelSet(id: ModelSetId): boolean {
  return registry.has(id);
}

/** 列出全部已注册模型集 */
export function listModelSets(): ModelSet[] {
  return Array.from(registry.values());
}

/** 取默认模型集（VoiceDesign） */
export function getDefaultModelSet(): ModelSet {
  return getModelSet(DEFAULT_MODEL_SET_ID);
}

/** 取模型集的基准契约（缺省回落默认契约） */
export function capabilityOf(set: ModelSet): ModelCapability {
  return set.capability ?? QWEN3_TTS_VD_CAPABILITY;
}

// ── 内建模型集注册 ──
// 新增模型集只需在此追加一行（或运行期调用 registerModelSet）。

registerModelSet(VOICEDESIGN_MODEL_SET);

// ── 运行期生效契约 ──

let activeCapability: ModelCapability = QWEN3_TTS_VD_CAPABILITY;
let activeModelSetId: ModelSetId = DEFAULT_MODEL_SET_ID;

/**
 * 用 manifest.json 文本刷新生效契约。
 *
 * manifest 无 `capability` 段 / 解析失败时，回落到该模型集的基准契约
 * —— 保证旧清单（如从 HF 下载的官方 manifest）依旧可用。
 *
 * @returns 实际生效的契约
 */
export function activateCapabilityFromManifest(
  manifestJson: string | null | undefined,
  modelSetId: ModelSetId = activeModelSetId,
): ModelCapability {
  const base = hasModelSet(modelSetId)
    ? capabilityOf(getModelSet(modelSetId))
    : QWEN3_TTS_VD_CAPABILITY;
  const override = parseCapabilityFromManifest(manifestJson);
  activeCapability = mergeCapability(base, override);
  activeModelSetId = modelSetId;
  return activeCapability;
}

/** 直接设置生效契约（测试或非 manifest 路径使用） */
export function setActiveCapability(cap: ModelCapability, modelSetId?: ModelSetId): void {
  activeCapability = cap;
  if (modelSetId) activeModelSetId = modelSetId;
}

/** 取当前生效契约 */
export function getActiveCapability(): ModelCapability {
  return activeCapability;
}

/** 取当前生效模型集 id */
export function getActiveModelSetId(): ModelSetId {
  return activeModelSetId;
}

/** 取当前生效契约声明的 tokenizer 文件位置（替代 BPE_*_PATH 硬编码） */
export function getActiveTokenizerFiles(): TokenizerFiles {
  return activeCapability.tokenizer;
}

/** 重置为默认（测试用） */
export function resetActiveCapability(): void {
  activeCapability = QWEN3_TTS_VD_CAPABILITY;
  activeModelSetId = DEFAULT_MODEL_SET_ID;
}

// ── 测试隔离 ──

/** 清空注册表（仅测试使用；清空后需重新注册内建模型集） */
export function __clearRegistryForTest(): void {
  registry.clear();
}

/** 重新注册内建模型集（仅测试使用） */
export function __registerBuiltinsForTest(): void {
  registerModelSet(VOICEDESIGN_MODEL_SET, { override: true });
}
