/**
 * src/hooks/useModelLoader.ts — 模型校验与加载 React Hook（仅 VoiceDesign 模型集）
 *
 * 两个工作模式：
 * 1) verifyDevModels — 轻量校验：仅验证文件存在 + 体积正确，不分配 ArrayBuffer（~数 MB 内存）
 * 2) loadDevModels   — 完整加载：读入 ArrayBuffer（~2.7GB），供 OrtSessionManager 推理使用
 *
 * 模型校验 Tab 只调 verify；音色建档 Tab 在合成前调 loadDevModels（若未加载）。
 */

import { useState, useCallback, useRef, useMemo } from 'react';
import { ModelLoader, getModelMode } from '@/core/modelLoader';
import { VOICEDESIGN_MODEL_SET } from '@/core/modelSet';
import { ModelStatus, type ModelLoadState } from '@/types';

interface UseModelLoaderReturn {
  states: ModelLoadState[];
  loading: boolean;
  progress: number;
  error: string | null;
  needsDownload: boolean;
  modelsReady: boolean;
  /** 完整加载后原始 buffer（key=文件名带 .onnx）；仅验证时为空 Map */
  buffers: Map<string, ArrayBuffer>;
  /** 轻量校验（仅验证文件，不加载到内存） */
  verifyDevModels: () => Promise<void>;
  /** 完整加载到内存（~2.7GB） */
  loadDevModels: () => Promise<void>;
  loadProdModels: () => Promise<void>;
  /** 从已有的 FileSystemDirectoryHandle 加载模型（不弹出选择器） */
  loadFromHandle: (handle: FileSystemDirectoryHandle) => Promise<void>;
  reset: () => void;
}

export function useModelLoader(): UseModelLoaderReturn {
  const loaderRef = useRef<ModelLoader>(new ModelLoader({ modelSet: VOICEDESIGN_MODEL_SET }));

  const [states, setStates] = useState<ModelLoadState[]>(loaderRef.current.getStates());
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsDownload, setNeedsDownload] = useState(false);
  const [buffers, setBuffers] = useState<Map<string, ArrayBuffer>>(new Map());

  const updateProgress = useCallback(() => {
    const cur = loaderRef.current.getStates();
    setStates([...cur]);
    const total = cur.length;
    const completed = cur.filter((s) => s.status === ModelStatus.VERIFIED || s.status === ModelStatus.SKIPPED).length;
    setProgress(total > 0 ? Math.round((completed / total) * 100) : 0);
  }, []);

  const run = useCallback(
    async (mode: 'dev' | 'prod', storeBuffers: boolean) => {
      setLoading(true);
      setError(null);
      setNeedsDownload(false);

      if (loaderRef.current) loaderRef.current.dispose();
      const loader = new ModelLoader({ modelSet: VOICEDESIGN_MODEL_SET, onProgress: () => updateProgress() });
      loaderRef.current = loader;

      try {
        const result = mode === 'dev' ? await loader.loadDevModels() : await loader.loadProdModels();
        updateProgress();
        setNeedsDownload(result.needsUserDownload);
        if (!result.success && result.errorMessage) setError(result.errorMessage);
        if (storeBuffers) setBuffers(new Map(loader.getBuffers()));
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [updateProgress],
  );

  /** 轻量校验：验证文件存在 + 体积，不持有 ArrayBuffer */
  const verifyDevModels = useCallback(async () => {
    await run('dev', false);
  }, [run]);

  const loadDevModels = useCallback(async () => {
    await run('dev', true);
  }, [run]);

  const loadProdModels = useCallback(async () => {
    await run('prod', true);
  }, [run]);

  const loadFromHandle = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setLoading(true); setError(null); setProgress(0);
    try {
      loaderRef.current.setDirHandle(handle);
      const result = await loaderRef.current.loadFromExistingHandle();
      setStates(result.states);
      if (result.success && result.buffers && result.buffers.size > 0) {
        setBuffers(new Map(result.buffers));
      } else {
        setError(result.errorMessage || '模型加载失败');
        setNeedsDownload(result.needsUserDownload);
      }
    } catch (err: any) {
      setError(err?.message || '加载异常');
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    loaderRef.current.dispose();
    loaderRef.current = new ModelLoader({ modelSet: VOICEDESIGN_MODEL_SET });
    setStates(loaderRef.current.getStates());
    setLoading(false);
    setProgress(0);
    setError(null);
    setNeedsDownload(false);
    setBuffers(new Map());
  }, []);

  const modelsReady = useMemo(
    () => states.filter((s) => s.file.required).every((s) => s.status === ModelStatus.VERIFIED),
    [states],
  );

  return {
    states,
    loading,
    progress,
    error,
    needsDownload,
    modelsReady,
    buffers,
    loadDevModels,
    loadProdModels,
    loadFromHandle,
    reset,
    verifyDevModels,
  };
}

export { getModelMode };
