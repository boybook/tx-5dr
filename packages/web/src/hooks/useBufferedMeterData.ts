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
    let next = buffered;
    const update = (key: keyof BufferedMeterData, value: MeterData[typeof key], isTimeout: boolean) => {
      if (next[key].value === value && next[key].isTimeout === isTimeout) return;
      next = { ...next, [key]: { value, isTimeout } };
    };
    const clearTimer = (key: keyof BufferedMeterData) => {
      if (timers.current[key] !== null) clearTimeout(timers.current[key]!);
      timers.current[key] = null;
    };
    (['swr', 'alc', 'level', 'power'] as const).forEach((key) => {
      const isTxKey = key === 'swr' || key === 'alc' || key === 'power';
      if (isTxKey && !isPttActive) {
        txEpochGuard.current.resolve(key, meterData[key], false);
        clearTimer(key);
        update(key, null, true);
        return;
      }
      const value = isTxKey ? txEpochGuard.current.resolve(key, meterData[key], true) : meterData[key];
      if (value !== null) {
        clearTimer(key);
        update(key, value, false);
      } else if (buffered[key].value !== null) {
        // Another meter can update while this one is missing. Keep its sample
        // and original deadline instead of clearing it or extending the hold.
        if (!buffered[key].isTimeout && timers.current[key] === null) {
          timers.current[key] = setTimeout(() => {
            timers.current[key] = null;
            setBuffered(previous => previous[key].isTimeout ? previous : {
              ...previous, [key]: { ...previous[key], isTimeout: true },
            });
          }, TIMEOUT_MS);
        }
      } else {
        update(key, null, true);
      }
    });
    if (next !== buffered) setBuffered(next);
  }, [isPttActive, meterData.swr, meterData.alc, meterData.level, meterData.power]);

  useEffect(() => () => {
    (['swr', 'alc', 'level', 'power'] as const).forEach(key => {
      if (timers.current[key] !== null) clearTimeout(timers.current[key]!);
      timers.current[key] = null;
    });
  }, []);

  return buffered;
}
