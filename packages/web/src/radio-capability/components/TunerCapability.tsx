/**
 * TunerCapability - 天调能力组件
 *
 * TunerCapabilityPanel: 用于 RadioControlPanel Modal（完整卡片，含开关+调谐按钮+SWR）
 * TunerCapabilitySurface: 用于 RadioControl 工具栏（Popover 内容，与现有 UI 保持一致）
 */

import React, { useState, useCallback } from 'react';
import { Switch, Button, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../CapabilityRegistry';
import { useCapabilityWriter } from '../CapabilityRegistry';
import { useCapabilityState } from '../../store/radioStore';

import { useCan } from '../../store/authStore';
import { createLogger } from '../../utils/logger';
import { getCapabilityUnavailableText, isCapabilityAvailable } from '../availability';

const logger = createLogger('TunerCapability');

// ===== Panel 版本（Modal 内完整控件）=====

export const TunerCapabilityPanel: React.FC<CapabilityComponentProps> = ({
  capabilityId,
  state,
  descriptor,
  onWrite,
}) => {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');
  const [isLoading, setIsLoading] = useState(false);
  const switchState = useCapabilityState('tuner_switch');
  const tuneState = useCapabilityState('tuner_tune');

  // tuner_switch 和 tuner_tune 共用一个面板卡片（compoundGroup）
  // 这里根据 compoundRole 渲染不同控件
  const role = descriptor.compoundRole;

  if (role === 'switch') {
    const enabled = typeof state?.value === 'boolean' ? state.value : false;
    const isSupported = state?.supported ?? false;
    const isAvailable = isCapabilityAvailable(state);
    const unavailableText = getCapabilityUnavailableText(state, t, capabilityId)
      ?? getCapabilityUnavailableText(tuneState, t, 'tuner_tune');
    const swr = (state?.meta as { swr?: number } | undefined)?.swr;

    const handleToggle = useCallback(async () => {
      if (!canControl || !isAvailable || isLoading) return;
      setIsLoading(true);
      try {
        onWrite(capabilityId, !enabled);
      } finally {
        // 等待 WS 确认后 setIsLoading(false)，通过 state 变化检测
        setTimeout(() => setIsLoading(false), 2000);
      }
    }, [canControl, isAvailable, isLoading, capabilityId, enabled, onWrite]);

    return (
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-1">
            <span className="text-sm font-medium">{t(descriptor.labelI18nKey)}</span>
            {descriptor.descriptionI18nKey && (
              <Tooltip content={t(descriptor.descriptionI18nKey)} size="sm" placement="top" classNames={{ content: 'max-w-[240px] text-xs' }}>
                <FontAwesomeIcon icon={faCircleInfo} className="text-default-300 text-xs cursor-help" />
              </Tooltip>
            )}
          </div>
          {swr !== undefined && (
            <div className={`text-xs font-mono mt-0.5 ${
              swr < 1.5 ? 'text-success' : swr < 2.0 ? 'text-warning' : 'text-danger'
            }`}>
              SWR {swr.toFixed(2)}
            </div>
          )}
          {unavailableText && (
            <div className="text-xs text-warning-600 mt-0.5">{unavailableText}</div>
          )}
        </div>
        <Switch
          isSelected={enabled}
          onValueChange={handleToggle}
          isDisabled={!isSupported || !isAvailable || !canControl || isLoading}
          size="sm"
        />
      </div>
    );
  }

  if (role === 'action') {
    // tuner_switch 的状态用于判断调谐器是否已启用
    const tunerEnabled = typeof switchState?.value === 'boolean' ? switchState.value : false;
    const tuningStatus = (switchState?.meta as { status?: string } | undefined)?.status;
    const isTuning = tuningStatus === 'tuning';
    const isTuneLoading = isLoading || isTuning;
    const isSupported = state?.supported ?? false;
    const isAvailable = isCapabilityAvailable(state) && isCapabilityAvailable(switchState);

    const handleTune = useCallback(async () => {
      if (!canControl || !isAvailable || isTuneLoading || !tunerEnabled) return;
      setIsLoading(true);
      logger.info('Manual tuning triggered');
      onWrite(capabilityId, undefined, true);
      setTimeout(() => setIsLoading(false), 2000);
    }, [canControl, isAvailable, isTuneLoading, tunerEnabled, capabilityId, onWrite]);

    return (
      <div className="space-y-1">
        <Button
          size="sm"
          variant="flat"
          color={isTuneLoading ? 'warning' : 'default'}
          onPress={handleTune}
          isLoading={isTuneLoading}
          isDisabled={!isSupported || !isAvailable || !canControl || !tunerEnabled || isTuneLoading}
          className="w-full"
        >
          {isTuneLoading ? t('radio:tuner.tuning') : t(descriptor.labelI18nKey)}
        </Button>
      </div>
    );
  }

  return null;
};

// ===== Surface 版本（工具栏 Popover 内容）=====

export const TunerCapabilitySurface: React.FC = () => {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');
  const switchState = useCapabilityState('tuner_switch');
  const tuneState = useCapabilityState('tuner_tune');
  const onWrite = useCapabilityWriter();

  const [isSwitchLoading, setIsSwitchLoading] = useState(false);
  const [isTuneLoading, setIsTuneLoading] = useState(false);

  const enabled = typeof switchState?.value === 'boolean' ? switchState.value : false;
  const tunerSupported = switchState?.supported ?? false;
  const tuneSupported = tuneState?.supported ?? false;
  const tunerAvailable = isCapabilityAvailable(switchState);
  const tuneAvailable = isCapabilityAvailable(tuneState);
  const unavailableText = getCapabilityUnavailableText(switchState, t, 'tuner_switch')
    ?? getCapabilityUnavailableText(tuneState, t, 'tuner_tune');
  const tuningStatus = (switchState?.meta as { status?: string } | undefined)?.status;
  const swr = (switchState?.meta as { swr?: number } | undefined)?.swr;
  const isTuning = tuningStatus === 'tuning';
  const isManualTuneLoading = isTuneLoading || isTuning;

  if (!canControl || !tunerSupported) {
    return null;
  }

  const handleToggle = useCallback(() => {
    if (!canControl || !tunerAvailable) return;
    setIsSwitchLoading(true);
    onWrite('tuner_switch', !enabled);
    setTimeout(() => setIsSwitchLoading(false), 2000);
  }, [canControl, tunerAvailable, enabled, onWrite]);

  const handleTune = useCallback(() => {
    if (!canControl || !tunerAvailable || !tuneAvailable || !enabled || isManualTuneLoading) return;
    setIsTuneLoading(true);
    logger.info('Manual tuning triggered from surface');
    onWrite('tuner_tune', undefined, true);
    setTimeout(() => setIsTuneLoading(false), 2000);
  }, [canControl, tunerAvailable, tuneAvailable, enabled, isManualTuneLoading, onWrite]);

  return (
    <div className="py-2 space-y-3 min-w-[160px]">
      {/* 天调开关 */}
      {tunerSupported && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t('radio:capability.tuner_switch.label')}</span>
          <Switch
            isSelected={enabled}
            onValueChange={handleToggle}
            isDisabled={!canControl || !tunerAvailable || isSwitchLoading}
            size="sm"
          />
        </div>
      )}

      {/* 手动调谐按钮 */}
      {tuneSupported && (
        <Button
          size="sm"
          variant="flat"
          color={isManualTuneLoading ? 'warning' : 'default'}
          onPress={handleTune}
          isLoading={isManualTuneLoading}
          isDisabled={!canControl || !tunerAvailable || !tuneAvailable || !enabled || isManualTuneLoading}
          className="w-full"
        >
          {isManualTuneLoading ? t('radio:tuner.tuning') : t('radio:capability.tuner_tune.label')}
        </Button>
      )}

      {/* SWR 显示 */}
      {swr !== undefined && (
        <div className="pt-2 border-t border-divider">
          <div className="flex items-center justify-between text-xs">
            <span className="text-default-500">SWR</span>
            <span className={`font-mono font-medium ${
              swr < 1.5 ? 'text-success' : swr < 2.0 ? 'text-warning' : 'text-danger'
            }`}>
              {swr.toFixed(2)}
            </span>
          </div>
        </div>
      )}
      {unavailableText && (
        <p className="text-xs text-warning-600">{unavailableText}</p>
      )}
    </div>
  );
};
