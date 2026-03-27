/**
 * NumberLevelCapability - 通用数值滑块面板组件
 *
 * 适用于 rf_power、af_gain、sql 等 number 类能力。
 * 拖动时节流 150ms 避免命令打满 CAT 总线。
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Slider, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../CapabilityRegistry';
import { useCan } from '../../store/authStore';

const WRITE_DEBOUNCE_MS = 150;

export const NumberLevelCapabilityPanel: React.FC<CapabilityComponentProps> = ({
  capabilityId,
  state,
  descriptor,
  onWrite,
}) => {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');

  const isSupported = state?.supported ?? false;
  const serverValue = typeof state?.value === 'number' ? state.value : null;
  const range = descriptor.range ?? { min: 0, max: 1 };

  // 本地展示值（跟随拖动实时更新，不等待服务端确认）
  const [localValue, setLocalValue] = useState<number | null>(serverValue);

  // 当服务端值变化时同步（用户不在拖动时才更新）
  const isDragging = useRef(false);
  useEffect(() => {
    if (!isDragging.current && serverValue !== null) {
      setLocalValue(serverValue);
    }
  }, [serverValue]);

  // 节流写入
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValue = useRef<number | null>(null);

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

  const handleChange = useCallback(
    (value: number | number[]) => {
      const v = Array.isArray(value) ? value[0] : value;
      isDragging.current = true;
      setLocalValue(v);
      scheduleWrite(v);
    },
    [scheduleWrite],
  );

  const handleChangeEnd = useCallback(() => {
    isDragging.current = false;
    // 立即触发最后一次写入
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    if (pendingValue.current !== null) {
      onWrite(capabilityId, pendingValue.current);
      pendingValue.current = null;
    }
  }, [capabilityId, onWrite]);

  const displayValue = localValue ?? serverValue ?? range.min;
  const displayPercent = Math.round(((displayValue - range.min) / (range.max - range.min)) * 100);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-sm font-medium">{t(descriptor.labelI18nKey)}</span>
          {descriptor.descriptionI18nKey && (
            <Tooltip content={t(descriptor.descriptionI18nKey)} size="sm" placement="top" classNames={{ content: 'max-w-[240px] text-xs' }}>
              <FontAwesomeIcon icon={faCircleInfo} className="text-default-300 text-xs cursor-help" />
            </Tooltip>
          )}
        </div>
        <span className="text-xs text-default-400 font-mono">
          {isSupported ? `${displayPercent}%` : '—'}
        </span>
      </div>
      <Slider
        size="sm"
        minValue={range.min}
        maxValue={range.max}
        step={descriptor.range?.step ?? 0.01}
        value={displayValue}
        onChange={handleChange}
        onChangeEnd={handleChangeEnd}
        isDisabled={!isSupported || !canControl}
        className="w-full"
        aria-label={t(descriptor.labelI18nKey)}
      />
      {!isSupported && (
        <p className="text-xs text-default-400">{t('radio:capability.panel.notSupported')}</p>
      )}
    </div>
  );
};
