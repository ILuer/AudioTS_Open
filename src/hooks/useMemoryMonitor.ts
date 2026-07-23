/**
 * src/hooks/useMemoryMonitor.ts — 内存监控 React Hook
 */

import { useState, useEffect, useRef } from 'react';
import { MemoryGuard } from '@/memory/memoryGuard';
import { MEMORY_MONITOR_INTERVAL_MS } from '@/core/constants';
import type { MemorySnapshot } from '@/types';

interface UseMemoryMonitorReturn {
  snapshot: MemorySnapshot | null;
  degraded: boolean;
  warning: boolean;
}

export function useMemoryMonitor(): UseMemoryMonitorReturn {
  const guardRef = useRef<MemoryGuard>(new MemoryGuard());
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [warning, setWarning] = useState(false);

  useEffect(() => {
    const guard = guardRef.current;
    const mem = guard.takeSnapshot();
    setSnapshot(mem);

    guard.onWarning((snap: MemorySnapshot) => {
      setSnapshot(snap);
      setWarning(true);
    });

    guard.onCritical((snap: MemorySnapshot) => {
      setSnapshot(snap);
      setWarning(true);
      setDegraded(true);
    });

    guard.startMonitoring(MEMORY_MONITOR_INTERVAL_MS);

    // 定期更新快照
    const snapshotInterval = setInterval(() => {
      const snap = guard.takeSnapshot();
      setSnapshot(snap);
      setDegraded(guard.isDegraded());
      setWarning(
        snap.jsHeapSizeLimit > 0 &&
        snap.usedJSHeapSize / snap.jsHeapSizeLimit >= 0.8
      );
    }, MEMORY_MONITOR_INTERVAL_MS);

    return () => {
      guard.stopMonitoring();
      clearInterval(snapshotInterval);
    };
  }, []);

  return { snapshot, degraded, warning };
}
