import { useState, useCallback } from 'react';
import type { ProcessSnapshot, ProcessSnapshotHistory } from '@tx5dr/contracts';
import type { RadioService } from '../services/radioService';
import { useWSEvents } from './useWSEvent';

// 显示的最大数据点数（30分钟 @ 2s = 900，默认展示最近数据）
export const SERVER_HEALTH_MAX_DISPLAY = 900;

export type HealthLevel = 'good' | 'warn' | 'critical' | 'unknown';

const MB = 1024 * 1024;
const HEAP_WARN_BYTES = 512 * MB;
const HEAP_CRITICAL_BYTES = 2048 * MB;
const EVENT_LOOP_WARN_MS = 50;
const EVENT_LOOP_CRITICAL_MS = 100;

export function getHealthLevel(snapshot: ProcessSnapshot | null): HealthLevel {
  if (!snapshot) return 'unknown';

  const { memory, eventLoop } = snapshot;

  if (
    eventLoop.p99 > EVENT_LOOP_CRITICAL_MS ||
    memory.heapUsed > HEAP_CRITICAL_BYTES
  ) {
    return 'critical';
  }

  if (
    eventLoop.p99 > EVENT_LOOP_WARN_MS ||
    memory.heapUsed > HEAP_WARN_BYTES
  ) {
    return 'warn';
  }

  return 'good';
}

export function useServerHealth(radioService: RadioService | null) {
  const [snapshots, setSnapshots] = useState<ProcessSnapshot[]>([]);

  const handleSnapshot = useCallback((s: ProcessSnapshot) => {
    setSnapshots(prev => {
      const next = [...prev, s];
      return next.length > SERVER_HEALTH_MAX_DISPLAY
        ? next.slice(-SERVER_HEALTH_MAX_DISPLAY)
        : next;
    });
  }, []);

  const handleHistory = useCallback((data: ProcessSnapshotHistory) => {
    setSnapshots(data.snapshots.slice(-SERVER_HEALTH_MAX_DISPLAY));
  }, []);

  useWSEvents(radioService, {
    processSnapshot: handleSnapshot,
    processSnapshotHistory: handleHistory,
  });

  const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  return {
    snapshots,
    latestSnapshot,
    health: getHealthLevel(latestSnapshot),
  };
}
