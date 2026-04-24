/**
 * NumberLevelCapability - 通用数值能力面板组件
 *
 * - percent 模式：使用 Slider，适合 rf_power / af_gain / sql / mic_gain / nb / nr
 * - value 模式：使用数字输入框，适合 RIT/XIT/中继偏移等非归一化参数
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Input, Slider, Tab, Tabs, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../CapabilityRegistry';
import type { CapabilityDescriptor } from '@tx5dr/contracts';
import { useCan } from '../../store/authStore';
import { formatCapabilityNumber, fromDisplayNumber, toDisplayNumber } from '../display-utils';

const WRITE_DEBOUNCE_MS = 150;
const DISCRETE_MATCH_EPSILON = 1e-6;
export type RfPowerInteractionMode = 'percent' | 'hamlib-discrete';
const RF_POWER_MODE_TABS_CLASSNAMES = {
  base: 'max-w-fit',
  tabList: 'gap-1 rounded-md bg-default-100 p-0.5',
  tab: 'h-6 min-w-0 px-2',
  tabContent: 'text-[11px] leading-none',
  cursor: 'rounded-[6px]',
} as const;

export function getDiscreteNumberOptions(descriptor: CapabilityDescriptor) {
  return (descriptor.discreteOptions ?? []).filter(
    (option): option is { value: number; label?: string; labelI18nKey?: string } => typeof option.value === 'number',
  );
}

export function isRfPowerCapability(capabilityId: string): boolean {
  return capabilityId === 'rf_power';
}

export function canUseRfPowerDiscreteMode(
  capabilityId: string,
  discreteOptions: Array<{ value: number }>,
): boolean {
  return isRfPowerCapability(capabilityId) && discreteOptions.length >= 2;
}

export function shouldUseDiscreteSlider(
  capabilityId: string,
  usesSlider: boolean,
  discreteOptions: Array<{ value: number }>,
  rfPowerMode: RfPowerInteractionMode,
): boolean {
  if (!usesSlider || discreteOptions.length < 2) {
    return false;
  }

  if (!isRfPowerCapability(capabilityId)) {
    return true;
  }

  return rfPowerMode === 'hamlib-discrete';
}

export function findDiscreteOptionIndex(
  options: Array<{ value: number }>,
  value: number | null | undefined,
): number {
  if (!options.length || value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }

  const exactIndex = options.findIndex((option) => Math.abs(option.value - value) < DISCRETE_MATCH_EPSILON);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  let nearestIndex = 0;
  let nearestDelta = Number.POSITIVE_INFINITY;
  options.forEach((option, index) => {
    const delta = Math.abs(option.value - value);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

export function getDiscreteOptionDisplayText(
  options: ReturnType<typeof getDiscreteNumberOptions>,
  descriptor: CapabilityDescriptor,
  value: number,
  t: (key: string) => string,
): string {
  const option = options[findDiscreteOptionIndex(options, value)];
  if (!option) {
    return formatCapabilityNumber(value, descriptor, true);
  }
  if (option.labelI18nKey) {
    return t(option.labelI18nKey);
  }
  if (option.label) {
    return option.label;
  }
  return formatCapabilityNumber(option.value, descriptor, true);
}

export const NumberLevelCapabilityPanel: React.FC<CapabilityComponentProps> = ({
  capabilityId,
  state,
  descriptor,
  onWrite,
}) => {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');

  const isSupported = state?.supported ?? false;
  const canWrite = descriptor.writable;
  const serverValue = typeof state?.value === 'number' ? state.value : null;
  const range = descriptor.range ?? { min: 0, max: 1, step: 0.01 };
  const usesSlider = descriptor.display?.mode === 'percent';
  const discreteOptions = getDiscreteNumberOptions(descriptor);
  const [rfPowerMode, setRfPowerMode] = useState<RfPowerInteractionMode>('percent');
  const showRfPowerModeToggle = canUseRfPowerDiscreteMode(capabilityId, discreteOptions);
  const isDiscreteSlider = shouldUseDiscreteSlider(capabilityId, usesSlider, discreteOptions, rfPowerMode);

  const [localValue, setLocalValue] = useState<number | null>(serverValue);
  const [inputValue, setInputValue] = useState<string>(
    serverValue !== null ? formatCapabilityNumber(serverValue, descriptor, false) : ''
  );

  const isDragging = useRef(false);
  useEffect(() => {
    if (!isDragging.current && serverValue !== null) {
      setLocalValue(serverValue);
      setInputValue(formatCapabilityNumber(serverValue, descriptor, false));
    }
  }, [descriptor, serverValue]);

  const discreteSignature = useMemo(
    () => discreteOptions.map((option) => `${option.value}:${option.label ?? option.labelI18nKey ?? ''}`).join('|'),
    [discreteOptions],
  );
  useEffect(() => {
    if (isRfPowerCapability(capabilityId)) {
      setRfPowerMode('percent');
    }
  }, [capabilityId, descriptor.id, discreteSignature]);

  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValue = useRef<number | null>(null);

  const cancelPendingWrite = useCallback(() => {
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    pendingValue.current = null;
    isDragging.current = false;
  }, []);

  useEffect(() => () => {
    cancelPendingWrite();
  }, [cancelPendingWrite]);

  const scheduleWrite = useCallback(
    (value: number) => {
      pendingValue.current = value;
      if (writeTimer.current) clearTimeout(writeTimer.current);
      writeTimer.current = setTimeout(() => {
        if (pendingValue.current !== null) {
          onWrite(capabilityId, pendingValue.current);
          pendingValue.current = null;
        }
        writeTimer.current = null;
      }, WRITE_DEBOUNCE_MS);
    },
    [capabilityId, onWrite],
  );

  const commitInputValue = useCallback(() => {
    const parsed = Number(inputValue);
    if (!Number.isFinite(parsed)) {
      if (serverValue !== null) {
        setInputValue(formatCapabilityNumber(serverValue, descriptor, false));
      }
      return;
    }

    const rawValue = fromDisplayNumber(parsed, descriptor);
    const clamped = Math.min(range.max, Math.max(range.min, rawValue));
    setLocalValue(clamped);
    setInputValue(formatCapabilityNumber(clamped, descriptor, false));
    onWrite(capabilityId, clamped);
  }, [capabilityId, descriptor, inputValue, onWrite, range.max, range.min, serverValue]);

  const handleSliderChange = useCallback(
    (value: number | number[]) => {
      const nextValue = Array.isArray(value) ? value[0] : value;
      const resolvedValue = isDiscreteSlider
        ? discreteOptions[Math.max(0, Math.min(discreteOptions.length - 1, Math.round(nextValue)))]?.value ?? range.min
        : nextValue;
      isDragging.current = true;
      setLocalValue(resolvedValue);
      scheduleWrite(resolvedValue);
    },
    [discreteOptions, isDiscreteSlider, range.min, scheduleWrite],
  );

  const handleSliderChangeEnd = useCallback(() => {
    isDragging.current = false;
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    if (pendingValue.current !== null) {
      onWrite(capabilityId, pendingValue.current);
      pendingValue.current = null;
    }
  }, [capabilityId, onWrite]);

  const handleRfPowerModeChange = useCallback(
    (key: React.Key) => {
      cancelPendingWrite();
      setRfPowerMode(String(key) as RfPowerInteractionMode);
    },
    [cancelPendingWrite],
  );

  const displayValue = localValue ?? serverValue ?? range.min;
  const discreteSliderValue = findDiscreteOptionIndex(discreteOptions, displayValue);
  const minDisplayValue = usesSlider ? range.min : toDisplayNumber(range.min, descriptor);
  const maxDisplayValue = usesSlider ? range.max : toDisplayNumber(range.max, descriptor);
  const displayText = isSupported
    ? (isDiscreteSlider
      ? getDiscreteOptionDisplayText(discreteOptions, descriptor, displayValue, t)
      : formatCapabilityNumber(displayValue, descriptor, true))
    : '—';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-sm font-medium">{t(descriptor.labelI18nKey)}</span>
          {descriptor.descriptionI18nKey && (
            <Tooltip content={t(descriptor.descriptionI18nKey)} size="sm" placement="top" classNames={{ content: 'max-w-[240px] text-xs' }}>
              <FontAwesomeIcon icon={faCircleInfo} className="text-default-300 text-xs cursor-help" />
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showRfPowerModeToggle && (
            <Tabs
              size="sm"
              selectedKey={rfPowerMode}
              onSelectionChange={handleRfPowerModeChange}
              isDisabled={!isSupported || !canControl || !canWrite}
              aria-label={t('radio:capability.rf_power.label')}
              classNames={RF_POWER_MODE_TABS_CLASSNAMES}
            >
              <Tab key="percent" title={t('radio:capability.rf_power.modes.percent')} />
              <Tab key="hamlib-discrete" title={t('radio:capability.rf_power.modes.hamlib')} />
            </Tabs>
          )}
          <span className="whitespace-nowrap text-xs text-default-400 font-mono">{displayText}</span>
        </div>
      </div>

      {usesSlider ? (
        <Slider
          size="sm"
          minValue={isDiscreteSlider ? 0 : range.min}
          maxValue={isDiscreteSlider ? discreteOptions.length - 1 : range.max}
          step={isDiscreteSlider ? 1 : (range.step ?? 0.01)}
          value={isDiscreteSlider ? discreteSliderValue : displayValue}
          onChange={handleSliderChange}
          onChangeEnd={handleSliderChangeEnd}
          isDisabled={!isSupported || !canControl || !canWrite}
          className="w-full"
          aria-label={t(descriptor.labelI18nKey)}
        />
      ) : (
        <Input
          size="sm"
          type="number"
          value={inputValue}
          onValueChange={setInputValue}
          onBlur={commitInputValue}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitInputValue();
            }
          }}
          min={String(minDisplayValue)}
          max={String(maxDisplayValue)}
          step={String(toDisplayNumber(range.step ?? 1, descriptor))}
          isDisabled={!isSupported || !canControl || !canWrite}
          aria-label={t(descriptor.labelI18nKey)}
        />
      )}

      {!isSupported && (
        <p className="text-xs text-default-400">{t('radio:capability.panel.notSupported')}</p>
      )}
    </div>
  );
};
