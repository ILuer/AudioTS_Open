/**
 * src/core/modelSet.ts — 模型集抽象与相对路径解析
 *
 * 每个模型集拥有独立的相对目录与文件清单，支持项目根相对路径解析
 * （dev：`/Models/...` 静态服务；prod：FSAA 选中目录），实现可移植。
 */

import type { ModelFileInfo } from '@/types';
import {
  getVoiceDesignModelDir,
  VOICEDESIGN_MODEL_FILES,
} from '@/core/constants';

/** 模型集标识 */
export type ModelSetId = 'voicedesign';

/** 模型集定义 */
export interface ModelSet {
  /** 唯一标识 */
  id: ModelSetId;
  /** 相对项目根的目录（dev：`Models/voicedesign/onnx`；prod：用户选中目录内对应子目录） */
  dir: string;
  /** 该集合包含的全部模型文件清单 */
  files: ModelFileInfo[];
  /** 是否由 manifest.json 的 sub_models 驱动（voicedesign=true；base=false，静态列表） */
  manifestDriven: boolean;
}

/** VoiceDesign 模型集（本次改造新增，相对路径）
 * dir 调用 getVoiceDesignModelDir() 获取动态路径（支持用户自定义 URL） */
export const VOICEDESIGN_MODEL_SET: ModelSet = {
  id: 'voicedesign',
  dir: getVoiceDesignModelDir(),
  files: VOICEDESIGN_MODEL_FILES,
  manifestDriven: true,
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
 * 从 manifest.json 动态加载模型文件清单。
 * 改进依据: 状态盘点报告 P1-1 — manifest.json 动态读取
 *
 * manifest.json 的 sub_models 为对象（键=模型名，值={filename}），
 * 不包含 sizeBytes/sha256/required —— 这些字段由调用方补充或使用默认值。
 *
 * @param dir - 模型集目录路径（如 'Models'）
 * @returns 解析后的模型文件信息数组
 * @throws 当 manifest.json 无法加载或解析失败时抛出
 */
export async function loadModelFilesFromManifest(dir: string): Promise<ModelFileInfo[]> {
  const url = `${dir}/manifest.json`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`无法加载 manifest: ${url} (HTTP ${resp.status})`);
  }
  const manifest = await resp.json();
  const subModels: Record<string, { filename: string }> = manifest.sub_models ?? {};
  return Object.values(subModels).map((m) => ({
    filename: m.filename,
    sizeBytes: 0,
    sha256: '',
    required: true,
  }));
}
