/**
 * src/hooks/useWorkerStatus.ts — Worker 状态 React Hook
 */

import { useState, useEffect } from 'react';
import { eventBus, AppEvents } from '@/core/eventBus';
import type { WorkerStatus } from '@/types';

interface UseWorkerStatusReturn {
  status: WorkerStatus;
  taskCount: number;
  isRebuilding: boolean;
  locked: boolean;
}

export function useWorkerStatus(): UseWorkerStatusReturn {
  const [status, setStatus] = useState<WorkerStatus>('idle');
  const [taskCount, setTaskCount] = useState(0);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const onStatusChange = (newStatus: WorkerStatus) => {
      setStatus(newStatus);
      setLocked(newStatus === 'busy');
    };

    const onLockChange = (isLocked: boolean) => {
      setLocked(isLocked);
    };

    eventBus.on(AppEvents.WORKER_STATUS_CHANGED, onStatusChange as (...args: unknown[]) => void);
    eventBus.on(AppEvents.LOCK_CHANGED, onLockChange as (...args: unknown[]) => void);

    return () => {
      eventBus.off(AppEvents.WORKER_STATUS_CHANGED, onStatusChange as (...args: unknown[]) => void);
      eventBus.off(AppEvents.LOCK_CHANGED, onLockChange as (...args: unknown[]) => void);
    };
  }, []);

  return { status, taskCount, isRebuilding, locked };
}
