import { useState, useCallback } from 'react';
import type { ProcessSnapshot, ProcessSnapshotHistory } from '@tx5dr/contracts';
import type { RadioService } from '../services/radioService';
import { useWSEvents } from './useWSEvent';

// 显示的最大数据点数（30分钟 @ 2s = 900，默认展示最近数据）
export const SERVER_HEALTH_MAX_DISPLAY = 900;

export type HealthLevel = 'good' | 'warn' | 'critical' | 'unknown';

const MB = 1024 * 1024;

export function getHealthLevel(snapshot: ProcessSnapshot | null): HealthLevel {
  if (!snapshot) return 'unknown';

  const { memory, cpu, eventLoop } = snapshot;

  if (
    memory.heapUsed > 1024 * MB ||
    cpu.total > 90 ||
    eventLoop.p99 > 100
  ) {
    return 'critical';
  }

  if (
    memory.heapUsed > 512 * MB ||
    cpu.total > 70 ||
    eventLoop.p99 > 50
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
