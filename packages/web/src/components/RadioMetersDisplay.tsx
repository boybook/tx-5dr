import React from 'react';
import type { MeterData } from '@tx5dr/contracts';
import { Progress } from '@heroui/react';
import { useBufferedMeterData } from '../hooks/useBufferedMeterData';

interface RadioMetersDisplayProps {
  meterData: MeterData;
  isPttActive: boolean;
  className?: string;
}

interface MeterProps {
  label: string;
  value: number | null;
  unit?: string;
  alert?: boolean;
  isTimeout?: boolean;
  formatValue?: (value: number) => string;
}

/**
 * 单个仪表组件
 */
const Meter: React.FC<MeterProps> = ({
  label,
  value,
  unit = '%',
  alert = false,
  isTimeout = false,
  formatValue
}) => {
  const displayValue = isTimeout || value === null
    ? '--'
    : formatValue ? formatValue(value) : value.toFixed(1);

  const progressValue = value === null || isTimeout ? 0 : value;
  const showUnit = displayValue !== '--';

  const getColor = () => {
    if (alert) return 'danger';
    if (progressValue > 80) return 'warning';
    if (progressValue > 50) return 'success';
    return 'primary';
  };

  return (
    <div className="flex-1 px-2">
      <div className="mb-1 flex items-center justify-between">
        <span className={`text-xs font-semibold ${
          alert
            ? 'text-danger dark:text-danger-400'
            : isTimeout
            ? 'text-default-400 dark:text-default-500'
            : 'text-default-700 dark:text-default-300'
        }`}>
          {label}
        </span>
        <span className={`text-xs font-mono tabular-nums ${
          alert
            ? 'text-danger font-bold animate-pulse'
            : isTimeout
            ? 'text-default-400 dark:text-default-500'
            : 'text-default-600 dark:text-default-400'
        }`}>
          {displayValue}{showUnit ? unit : ''}
        </span>
      </div>
      <Progress
        value={progressValue}
        maxValue={100}
        color={getColor()}
        size="sm"
        aria-label={label}
        classNames={{
          base: 'max-w-full',
          track: 'bg-default-200 dark:bg-default-100',
          indicator: alert ? 'animate-pulse' : '',
        }}
      />
    </div>
  );
};

/**
 * 电台数值表显示组件
 * 显示 SWR、ALC、Level/Power 仪表（带 3 秒缓冲）
 */
export const RadioMetersDisplay: React.FC<RadioMetersDisplayProps> = ({
  meterData,
  isPttActive,
  className = ''
}) => {
  const buffered = useBufferedMeterData(meterData);

  return (
    <div className={`w-full px-2 py-2 pt-1.5 bg-default-50 dark:bg-default-100/50 rounded-lg border border-default-200 dark:border-default-100 ${className}`}>
      <div className="flex items-center gap-2">
        {/* 第一个仪表：根据 PTT 状态动态切换 Level/Power */}
        {isPttActive ? (
          <Meter
            label="Power"
            value={buffered.power.value?.percent ?? null}
            unit="%"
            isTimeout={buffered.power.isTimeout}
          />
        ) : (
          <Meter
            label="Level"
            value={buffered.level.value?.percent ?? null}
            unit=""
            isTimeout={buffered.level.isTimeout}
            formatValue={(_value) => {
              if (!buffered.level.value) return '--';
              const { formatted, dBm, percent } = buffered.level.value;

              // 如果缺少完整数据（Hamlib 等），使用百分比显示
              if (formatted === undefined || dBm === undefined) {
                return `${percent.toFixed(1)}%`;
              }

              // 完整数据（ICOM WLAN），显示详细信息
              return `${formatted} / ${dBm.toFixed(1)}dBm`;
            }}
          />
        )}

        {/* SWR 驻波比表 */}
        <Meter
          label="SWR"
          value={buffered.swr.value ? (buffered.swr.value.raw / 255) * 100 : null}
          unit=""
          alert={buffered.swr.value?.alert}
          isTimeout={buffered.swr.isTimeout || (!isPttActive && buffered.swr.value?.raw === 0)}
          formatValue={(_value) => {
            if (!buffered.swr.value) return '0.0';
            const raw = buffered.swr.value.raw;
            if (raw <= 128) {
              const swr = 1.0 + (raw / 128) * 2.0;
              return swr.toFixed(1);
            }
            return '∞';
          }}
        />

        {/* ALC 自动电平控制表 */}
        <Meter
          label="ALC"
          value={buffered.alc.value?.percent ?? null}
          unit="%"
          alert={buffered.alc.value?.alert}
          isTimeout={buffered.alc.isTimeout || !isPttActive}
        />
      </div>
    </div>
  );
};
