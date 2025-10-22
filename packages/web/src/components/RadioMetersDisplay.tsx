import React from 'react';
import type { MeterData } from '@tx5dr/contracts';
import { Progress } from '@heroui/react';

interface RadioMetersDisplayProps {
  meterData: MeterData;
  isPttActive: boolean;
  className?: string;
}

interface MeterProps {
  label: string;
  value: number;
  unit?: string;
  alert?: boolean;
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
  formatValue
}) => {
  const displayValue = formatValue ? formatValue(value) : value.toFixed(1);

  // 根据值和告警状态确定颜色
  const getColor = () => {
    if (alert) return 'danger';
    if (value > 80) return 'warning';
    if (value > 50) return 'success';
    return 'primary';
  };

  return (
    <div className="flex-1 px-2">
      <div className="mb-1 flex items-center justify-between">
        <span className={`text-xs font-semibold ${
          alert
            ? 'text-danger dark:text-danger-400'
            : 'text-default-700 dark:text-default-300'
        }`}>
          {label}
        </span>
        <span className={`text-xs font-mono tabular-nums ${
          alert
            ? 'text-danger font-bold animate-pulse'
            : 'text-default-600 dark:text-default-400'
        }`}>
          {displayValue}{unit}
        </span>
      </div>
      <Progress
        value={value}
        maxValue={100}
        color={getColor()}
        size="sm"
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
 * 显示 SWR、ALC、Level 三个仪表
 */
export const RadioMetersDisplay: React.FC<RadioMetersDisplayProps> = ({
  meterData,
  isPttActive,
  className = ''
}) => {
  return (
    <div className={`w-full px-2 py-2 pt-1.5 bg-default-50 dark:bg-default-100/50 rounded-lg border border-default-200 dark:border-default-100 ${className}`}>
      <div className="flex items-center gap-2">
        {/* 第一个仪表：根据 PTT 状态动态切换 Level/Power */}
        {isPttActive ? (
          // TX 模式：显示发射功率
          meterData.power && (
            <Meter
              label="Power"
              value={meterData.power.percent}
              unit="%"
            />
          )
        ) : (
          // RX 模式：显示接收电平表
          meterData.level && (
            <Meter
              label="Level"
              value={meterData.level.percent}
              unit="%"
            />
          )
        )}

        {/* SWR 驻波比表 */}
        {meterData.swr && (
          <Meter
            label="SWR"
            value={(meterData.swr.raw / 255) * 100}
            unit=""
            alert={meterData.swr.alert}
            formatValue={() => {
              if (!meterData.swr) return '0.0';
              const raw = meterData.swr.raw;

              // 0-128: 线性映射到 1.0-3.0
              if (raw <= 128) {
                const swr = 1.0 + (raw / 128) * 2.0; // 1.0 到 3.0
                return swr.toFixed(1);
              }

              // 128-255: 显示为无穷大
              return '∞';
            }}
          />
        )}

        {/* ALC 自动电平控制表 */}
        {meterData.alc && (
          <Meter
            label="ALC"
            value={meterData.alc.percent}
            unit="%"
            alert={meterData.alc.alert}
          />
        )}

        {/* 如果所有数据都为 null，显示提示 */}
        {!meterData.swr && !meterData.alc && !meterData.level && (
          <div className="flex-1 text-center text-xs text-default-400 py-1">
            等待数值表数据...
          </div>
        )}
      </div>
    </div>
  );
};
