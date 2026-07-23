/**
 * src/hooks/useEPStatus.ts — EP 状态 React Hook
 *
 * 订阅 EP_CHANGED 事件，为 StatusBar / PerfPanel 等组件提供 EP 状态。
 * 初始状态为 null（isLoading=true），等待 App.tsx 完成 EP 选择后通过 EventBus 推送。
 */

import { useState, useEffect } from 'react';
import { eventBus, AppEvents } from '@/core/eventBus';
import type { EPStatus } from '@/types';

interface UseEPStatusReturn {
  /** 当前 EP 状态（EP 选择完成前为 null） */
  epStatus: EPStatus | null;
  /** 是否使用 WebGPU */
  isWebGPU: boolean;
  /** EP 选择是否仍在进行中 */
  isLoading: boolean;
  /** EP 选择过程中的错误 */
  error: string | null;
}

export function useEPStatus(): UseEPStatusReturn {
  const [epStatus, setEpStatus] = useState<EPStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onEPChanged = (status: EPStatus) => {
      setEpStatus(status);
      setIsLoading(false);
      setError(null);
    };

    const unsubscribe = eventBus.on(
      AppEvents.EP_CHANGED,
      onEPChanged as (...args: unknown[]) => void,
    );

    return () => {
      unsubscribe();
    };
  }, []);

  const isWebGPU = epStatus?.isWebGPU ?? false;

  return { epStatus, isWebGPU, isLoading, error };
}
