/**
 * src/core/modelSet.ts — 模型集抽象与相对路径解析
 *
 * 每个模型集拥有独立的相对目录、文件清单与能力契约，支持项目根相对路径解析
 * （dev：`/Models/...` 静态服务；prod：FSAA 选中目录），实现可移植。
 *
 * 多模型可插拔改造（dev 分支）:
 *   - ModelSetId 由字面量联合放宽为 string —— 新增模型集不再需要改类型
 *   - ModelSet 增加 label / capability / hfUrl，模型集自描述
 *   - 具体注册与查询统一走 @/core/modelRegistry
 */

import type { ModelFileInfo } from '@/types';
import type { ModelCapability } from '@/types/capability';
import { QWEN3_TTS_VD_CAPABILITY } from '@/core/modelCapability';
import {
  getVoiceDesignModelDir,
  VOICEDESIGN_MODEL_FILES,
  HF_MODEL_URL,
} from '@/core/constants';

/** 模型集标识（放宽为 string，新增模型集无需改动类型定义） */
export type ModelSetId = string;

/** 内建默认模型集 id */
export const DEFAULT_MODEL_SET_ID = 'voicedesign';

/** 模型集定义 */
export interface ModelSet {
  /** 唯一标识 */
  id: ModelSetId;
  /** 人类可读标签（UI 展示用） */
  label: string;
  /** 相对项目根的目录（dev：`Models`；prod：用户选中目录内对应子目录） */
  dir: string;
  /** 该集合包含的全部模型文件清单 */
  files: ModelFileInfo[];
  /** 是否由 manifest.json 的 sub_models 驱动 */
  manifestDriven: boolean;
  /** 下载地址（各模型集可不同） */
  hfUrl?: string;
  /**
   * 能力契约（session/张量/timing/tokenizer 契约）。
   * 缺省时由 modelRegistry 回落到 QWEN3_TTS_VD_CAPABILITY。
   */
  capability?: ModelCapability;
}

/** VoiceDesign 模型集（相对路径）
 * dir 调用 getVoiceDesignModelDir() 获取动态路径（支持用户自定义 URL） */
export const VOICEDESIGN_MODEL_SET: ModelSet = {
  id: DEFAULT_MODEL_SET_ID,
  label: 'VoiceDesign 1.7B',
  dir: getVoiceDesignModelDir(),
  files: VOICEDESIGN_MODEL_FILES,
  manifestDriven: true,
  hfUrl: HF_MODEL_URL,
  capability: QWEN3_TTS_VD_CAPABILITY,
};

/**
 * 解析单个模型文件的相对路径。
 * dev：`/${set.dir}/${filename}`（由 Vite 根目录静态服务）
 * prod：从 showDirectoryPicker 得到的 dirHandle 内按 filename 读取（逻辑在 modelLoader.ts）
 */
export function getModelPath(set: ModelSet, filename: string): string {
  return `/${set.dir}/${filename}`;
}

/** 解析模型集 manifest.json 的相对路径 */
export function getManifestPath(set: ModelSet): string {
  return `/${set.dir}/manifest.json`;
}

/**
 * 由文件名推导 ONNX 模型在 Worker 中注册的 session 名
 * （去掉 .onnx 后缀，与 manifest sub_models 的 key 对齐）。
 * 例如 `text_embed.onnx` → `text_embed`。
 */
export function modelNameFromFile(filename: string): string {
  return filename.replace(/\.onnx$/, '');
}

/**
 * 从 manifest.json 的 sub_models 段读取文件清单。
 *
 * manifest 的 sub_models 只提供 filename，不含 sizeBytes/sha256/required。
 * 若直接以 sizeBytes=0 返回，ModelLoader 的体积校验会全部误报 SIZE_MISMATCH
 * —— 因此这里与基准清单按文件名合并，未知文件才以宽松默认值补充。
 *
 * @param manifest manifest.json 解析后的对象
 * @param baseline 基准清单（通常是 constants 中的静态清单）
 */
export function mergeFilesFromManifest(
  manifest: unknown,
  baseline: ModelFileInfo[],
): ModelFileInfo[] {
  const obj = manifest as { sub_models?: Record<string, { filename?: string }> } | null;
  const subModels = obj?.sub_models;
  if (!subModels || typeof subModels !== 'object') return baseline;

  const byName = new Map(baseline.map((f) => [f.filename, f]));
  const merged: ModelFileInfo[] = [];
  const seen = new Set<string>();

  for (const entry of Object.values(subModels)) {
    const filename = entry?.filename;
    if (typeof filename !== 'string' || seen.has(filename)) continue;
    seen.add(filename);
    const known = byName.get(filename);
    merged.push(
      known
        ? { ...known }
        : { filename, sizeBytes: 0, sha256: '', required: true },
    );
  }

  // 基准清单中 manifest 未列出但磁盘存在的文件（如非缓存 talker.onnx）需保留
  for (const f of baseline) {
    if (!seen.has(f.filename)) merged.push({ ...f });
  }

  return merged;
}

/**
 * 解析 manifest.json 文本为对象（容错）。
 * @returns 解析成功返回对象，失败返回 null
 */
export function parseManifestJson(json: string | undefined | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
