import React from 'react';
import type { MeterData, MeterCapabilities } from '@tx5dr/contracts';
import { Popover, PopoverContent, PopoverTrigger, Progress } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useBufferedMeterData } from '../hooks/useBufferedMeterData';
import { TxVolumeGainControl } from './TxVolumeGainControl';

const LEVEL_DBM_MIN_CARD_WIDTH = 480;

interface RadioMetersDisplayProps {
  meterData: MeterData;
  isPttActive: boolean;
  meterCapabilities: MeterCapabilities | null;
  className?: string;
}

interface MeterProps {
  label: string;
  value: number | null;
  unit?: string;
  alert?: boolean;
  isTimeout?: boolean;
  formatValue?: (value: number) => string;
  renderDisplayValue?: () => React.ReactNode;
}

function clampProgressValue(value: number): number {
  return Math.min(100, Math.max(0, value));
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
  formatValue,
  renderDisplayValue
}) => {
  const displayValue = isTimeout || value === null
    ? '--'
    : formatValue ? formatValue(value) : value.toFixed(1);

  const progressValue = value === null || isTimeout ? 0 : clampProgressValue(value);
  const showUnit = displayValue !== '--';

  const getColor = () => {
    if (alert) return 'danger';
    if (progressValue > 80) return 'warning';
    if (progressValue > 50) return 'success';
    return 'primary';
  };

  const isWarning = !alert && progressValue > 80;

  return (
    <div className="flex-1 px-2">
      <div className="mb-1 flex items-center justify-between">
        <span className={`text-xs font-semibold ${
          alert
            ? 'text-danger dark:text-danger-400'
            : isWarning
            ? 'text-warning dark:text-warning-400'
            : isTimeout
            ? 'text-default-400 dark:text-default-500'
            : 'text-default-700 dark:text-default-300'
        }`}>
          {label}
        </span>
        <span className={`text-xs font-mono tabular-nums ${
          alert
            ? 'text-danger font-bold animate-pulse'
            : isWarning
            ? 'text-warning font-semibold'
            : isTimeout
            ? 'text-default-400 dark:text-default-500'
            : 'text-default-600 dark:text-default-400'
        }`}>
          {(isTimeout || value === null) ? '--' : (renderDisplayValue ? renderDisplayValue() : <>{displayValue}{showUnit ? unit : ''}</>)}
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
 * 根据 meterCapabilities 条件渲染：不支持的仪表隐藏，全不支持时隐藏整个组件
 */
export const RadioMetersDisplay: React.FC<RadioMetersDisplayProps> = ({
  meterData,
  isPttActive,
  meterCapabilities,
  className = ''
}) => {
  const { t } = useTranslation('radio');
  const buffered = useBufferedMeterData(meterData);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [showLevelDbmDetail, setShowLevelDbmDetail] = React.useState(true);
  const [isAlcPopoverOpen, setIsAlcPopoverOpen] = React.useState(false);
  const [hasAlcPopoverInteraction, setHasAlcPopoverInteraction] = React.useState(false);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const updateVisibility = (width: number) => {
      setShowLevelDbmDetail(width >= LEVEL_DBM_MIN_CARD_WIDTH);
    };

    updateVisibility(container.getBoundingClientRect().width);

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateVisibility(entry.contentRect.width);
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // 判断各仪表是否应显示（null = 未知，保持全显示以兼容旧版后端）
  const showLevelPower = meterCapabilities === null || meterCapabilities.strength || meterCapabilities.power;
  const showSwr = meterCapabilities === null || meterCapabilities.swr;
  const showAlc = meterCapabilities === null || meterCapabilities.alc;
  const isAlcOverLimit = showAlc
    && isPttActive
    && buffered.alc.value !== null
    && !buffered.alc.isTimeout
    && buffered.alc.value.percent >= 100;

  React.useEffect(() => {
    if (!showAlc) {
      setIsAlcPopoverOpen(false);
      setHasAlcPopoverInteraction(false);
      return;
    }

    if (isAlcOverLimit) {
      setIsAlcPopoverOpen(true);
      return;
    }

    if (!hasAlcPopoverInteraction) {
      setIsAlcPopoverOpen(false);
    }
  }, [hasAlcPopoverInteraction, isAlcOverLimit, showAlc]);

  const handleAlcPopoverOpenChange = React.useCallback((open: boolean) => {
    if (!open) {
      if (isAlcOverLimit) {
        setIsAlcPopoverOpen(true);
        return;
      }

      setIsAlcPopoverOpen(false);
      setHasAlcPopoverInteraction(false);
      return;
    }

    if (isAlcOverLimit || hasAlcPopoverInteraction) {
      setIsAlcPopoverOpen(true);
    }
  }, [hasAlcPopoverInteraction, isAlcOverLimit]);

  // 全部不支持时隐藏整个组件
  if (!showLevelPower && !showSwr && !showAlc) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={[
        'w-full px-2 py-2 pt-1.5 rounded-lg border transition-colors',
        isAlcOverLimit
          ? 'bg-danger-50 dark:bg-danger-500/15 border-danger/60 dark:border-danger-400/60 shadow-sm'
          : 'bg-default-50 dark:bg-default-100/50 border-default-200 dark:border-default-100',
        className,
      ].filter(Boolean).join(' ')}
    >
      <div className="flex items-center gap-2">
        {/* 第一个仪表：根据 PTT 状态动态切换 Level/Power */}
        {showLevelPower && (isPttActive ? (
          <Meter
            label="Power"
            value={buffered.power.value?.percent ?? null}
            unit={buffered.power.value?.watts != null && buffered.power.value?.maxWatts != null ? '' : (buffered.power.value?.watts != null ? 'W' : '%')}
            isTimeout={buffered.power.isTimeout}
            formatValue={(_value) => {
              if (!buffered.power.value) return '--';
              const { watts, percent, maxWatts } = buffered.power.value;
              if (watts != null && maxWatts != null) return `${watts.toFixed(1)}/${maxWatts.toFixed(1)}W`;
              if (watts != null) return watts.toFixed(1);
              return percent.toFixed(1);
            }}
          />
        ) : (
          <Meter
            label="Level"
            value={buffered.level.value?.percent ?? null}
            unit=""
            isTimeout={buffered.level.isTimeout}
            renderDisplayValue={() => {
              if (!buffered.level.value) return '--';
              const { formatted, dBm } = buffered.level.value;
              return (
                <>
                  {formatted}
                  {showLevelDbmDetail && <span> / {dBm.toFixed(1)}dBm</span>}
                </>
              );
            }}
          />
        ))}

        {/* SWR 驻波比表（对数刻度：1.0=0%, 2.0≈50%, 3.0≈75%, 10+=100%） */}
        {showSwr && (
          <Meter
            label="SWR"
            value={buffered.swr.value ? (() => {
              const swr = buffered.swr.value!.swr;
              if (swr <= 1.0) return 0;
              // 对数映射：log(swr)/log(10) * 100，SWR 1→0%, 10→100%
              return Math.min(100, (Math.log(swr) / Math.log(10)) * 100);
            })() : null}
            unit=""
            alert={buffered.swr.value?.alert}
            isTimeout={buffered.swr.isTimeout || !isPttActive}
            formatValue={(_value) => {
              if (!buffered.swr.value) return '1.0';
              const swr = buffered.swr.value.swr;
              if (swr >= 99) return '∞';
              return swr.toFixed(1);
            }}
          />
        )}

        {/* ALC 自动电平控制表 */}
        {showAlc && (
          <Popover
            isOpen={isAlcPopoverOpen}
            onOpenChange={handleAlcPopoverOpenChange}
            placement="top"
            offset={12}
          >
            <PopoverTrigger>
              <div className="flex-1 min-w-0">
                <div className={`rounded-md transition-colors ${isAlcOverLimit ? 'bg-danger-100/80 dark:bg-danger-500/10' : ''}`}>
                  <Meter
                    label="ALC"
                    value={buffered.alc.value?.percent ?? null}
                    unit="%"
                    alert={buffered.alc.value?.alert}
                    isTimeout={buffered.alc.isTimeout || !isPttActive}
                  />
                </div>
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-0">
              <div className="space-y-3 p-3">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-danger">
                    {t('alcWarning.title')}
                  </div>
                  <div className="text-xs leading-relaxed text-default-600 dark:text-default-300">
                    {t('alcWarning.description')}
                  </div>
                </div>
                <TxVolumeGainControl
                  orientation="horizontal"
                  onInteracted={() => {
                    setHasAlcPopoverInteraction(true);
                    setIsAlcPopoverOpen(true);
                  }}
                  ariaLabel={t('alcWarning.gainControl')}
                  className="w-full"
                  sliderClassName="w-full"
                />
                <div className="text-[11px] text-default-400">
                  {t('alcWarning.dismissHint')}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
};
