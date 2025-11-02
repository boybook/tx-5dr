import { useEffect, useRef, useState } from 'react';
import type { MeterData } from '@tx5dr/contracts';

export type BufferedMeterData = {
  swr: { value: MeterData['swr']; isTimeout: boolean };
  alc: { value: MeterData['alc']; isTimeout: boolean };
  level: { value: MeterData['level']; isTimeout: boolean };
  power: { value: MeterData['power']; isTimeout: boolean };
};

const TIMEOUT_MS = 3000;

/**
 * 数值表数据缓冲 Hook
 * - 数据变 null 时保持显示旧值 3 秒
 * - 超时后标记 isTimeout 用于显示 '--'
 */
export function useBufferedMeterData(meterData: MeterData): BufferedMeterData {
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

  useEffect(() => {
    (['swr', 'alc', 'level', 'power'] as const).forEach((key) => {
      const newValue = meterData[key];
      const currentValue = buffered[key].value;

      if (timers.current[key]) {
        clearTimeout(timers.current[key]!);
        timers.current[key] = null;
      }

      if (newValue !== null) {
        // 有数据：立即更新
        setBuffered((prev) => ({
          ...prev,
          [key]: { value: newValue, isTimeout: false },
        }));
      } else if (currentValue !== null) {
        // 数据变 null：保持旧值，启动超时
        timers.current[key] = setTimeout(() => {
          setBuffered((prev) => ({
            ...prev,
            [key]: { ...prev[key], isTimeout: true },
          }));
        }, TIMEOUT_MS);
      } else {
        // 一直无数据：标记超时
        setBuffered((prev) => ({
          ...prev,
          [key]: { value: null, isTimeout: true },
        }));
      }
    });

    return () => {
      Object.values(timers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, [meterData.swr, meterData.alc, meterData.level, meterData.power]);

  return buffered;
}
