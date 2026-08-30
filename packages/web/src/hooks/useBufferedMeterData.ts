import { useEffect, useRef, useState } from 'react';
import type { MeterData } from '@tx5dr/contracts';

export type BufferedMeterData = {
  swr: { value: MeterData['swr']; isTimeout: boolean };
  alc: { value: MeterData['alc']; isTimeout: boolean };
  level: { value: MeterData['level']; isTimeout: boolean };
  power: { value: MeterData['power']; isTimeout: boolean };
};

const TIMEOUT_MS = 3000;
type TxMeterKey = 'swr' | 'alc' | 'power';

export class TxMeterEpochGuard {
  private readonly suppressedSources = new Map<TxMeterKey, unknown>();

  resolve<K extends TxMeterKey>(key: K, value: MeterData[K], isPttActive: boolean): MeterData[K] {
    if (!isPttActive) {
      this.suppressedSources.set(key, value);
      return null;
    }
    if (this.suppressedSources.get(key) === value) return null;
    if (value !== null) this.suppressedSources.delete(key);
    return value;
  }
}

/**
 * 数值表数据缓冲 Hook
 * - 数据变 null 时保持显示旧值 3 秒
 * - 超时后标记 isTimeout 用于显示 '--'
 */
export function useBufferedMeterData(meterData: MeterData, isPttActive: boolean): BufferedMeterData {
  const [buffered, setBuffered] = useState<BufferedMeterData>({
    swr: { value: meterData.swr, isTimeout: false },
    alc: { value: meterData.alc, isTimeout: false },
    level: { value: meterData.level, isTimeout: false },
    power: { value: meterData.power, isTimeout: false },
  });

  const timers = useRef<Record<keyof MeterData, NodeJS.Timeout | null>>({
    swr: null,
    alc: null,
    level: null,
    power: null,
  });
  const txEpochGuard = useRef(new TxMeterEpochGuard());

  useEffect(() => {
    (['swr', 'alc', 'level', 'power'] as const).forEach((key) => {
      const isTxKey = key === 'swr' || key === 'alc' || key === 'power';
      if (isTxKey && !isPttActive) {
        txEpochGuard.current.resolve(key, meterData[key], false);
        if (timers.current[key]) {
          clearTimeout(timers.current[key]!);
          timers.current[key] = null;
        }
        setBuffered((prev) => ({
          ...prev,
          [key]: { value: null, isTimeout: true },
        }));
        return;
      }

      const sourceValue = meterData[key];
      const newValue = isTxKey
        ? txEpochGuard.current.resolve(key, sourceValue, true)
        : sourceValue;
      const currentValue = buffered[key].value;

      if (newValue !== null) {
        if (timers.current[key]) {
          clearTimeout(timers.current[key]!);
          timers.current[key] = null;
        }
        // 有数据：立即更新
        setBuffered((prev) => ({
          ...prev,
          [key]: { value: newValue, isTimeout: false },
        }));
      } else if (currentValue !== null && !timers.current[key]) {
        // 数据变 null：保持旧值，启动超时
        timers.current[key] = setTimeout(() => {
          setBuffered((prev) => ({
            ...prev,
            [key]: { ...prev[key], isTimeout: true },
          }));
          timers.current[key] = null;
        }, TIMEOUT_MS);
      } else {
        // 一直无数据：标记超时
        setBuffered((prev) => ({
          ...prev,
          [key]: { value: null, isTimeout: true },
        }));
      }
    });

  }, [isPttActive, meterData.swr, meterData.alc, meterData.level, meterData.power]);

  useEffect(() => {
    return () => {
      Object.values(timers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  return buffered;
}
