import React, { useCallback, useMemo } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger, Switch, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faGear } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useCan } from '../../../store/authStore';
import { useCapabilityDescriptor, useCapabilityState } from '../../../store/radioStore';
import { useCapabilityWriter } from '../../../radio-capability/CapabilityRegistry';
import { getCapabilityUnavailableText, isCapabilityInteractive } from '../../../radio-capability/availability';

const SPLIT_CAPABILITY_ID = 'split_enabled';

export const SplitSettingsPopover: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();
  const descriptor = useCapabilityDescriptor(SPLIT_CAPABILITY_ID);
  const state = useCapabilityState(SPLIT_CAPABILITY_ID);
  const canControl = useCan('execute', 'RadioControl');
  const writeCapability = useCapabilityWriter();

  const canWrite = descriptor?.writable ?? false;
  const isInteractive = isCapabilityInteractive(state, canControl, canWrite);
  const enabled = state?.value === true;
  const label = descriptor ? t(descriptor.labelI18nKey) : t('radio:frequency.splitLabelFallback');
  const unavailableText = getCapabilityUnavailableText(state, t, SPLIT_CAPABILITY_ID);

  const disabledReason = useMemo(() => {
    if (state?.supported === false) {
      return t('radio:frequency.splitUnsupported');
    }
    if (!descriptor || !state) {
      return t('radio:frequency.splitDetecting');
    }
    if (unavailableText) {
      return unavailableText;
    }
    if (!canWrite) {
      return t('radio:frequency.splitReadOnly');
    }
    if (!canControl) {
      return t('radio:frequency.splitPermissionRequired');
    }
    return null;
  }, [canControl, canWrite, descriptor, state, t, unavailableText]);

  const handleToggle = useCallback((value: boolean) => {
    if (!isInteractive) return;
    writeCapability(SPLIT_CAPABILITY_ID, value);
  }, [isInteractive, writeCapability]);

  const splitRow = (
    <div className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 ${!isInteractive ? 'text-default-400' : ''}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium">{label}</span>
          {descriptor?.descriptionI18nKey && (
            <Tooltip content={t(descriptor.descriptionI18nKey)} size="sm" placement="top" classNames={{ content: 'max-w-[240px] text-xs' }}>
              <FontAwesomeIcon icon={faCircleInfo} className="shrink-0 cursor-help text-xs text-default-300" />
            </Tooltip>
          )}
        </div>
        {disabledReason && (
          <div className="truncate text-[11px] text-default-400">{disabledReason}</div>
        )}
      </div>
      <Switch
        size="sm"
        isSelected={enabled}
        isDisabled={!isInteractive}
        onValueChange={handleToggle}
        aria-label={label}
      />
    </div>
  );

  return (
    <Popover placement="bottom-end">
      <PopoverTrigger>
        <Button
          isIconOnly
          size="sm"
          variant="light"
          aria-label={t('radio:frequency.splitSettingsAria')}
          className={`rounded-md text-default-400 ${className ?? 'h-7 min-w-7'}`}
        >
          <FontAwesomeIcon icon={faGear} className="text-xs" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 gap-2 p-3">
        <div className="flex w-full flex-col gap-2">
          <div className="text-sm font-semibold text-foreground">{t('radio:frequency.splitSettingsTitle')}</div>
          {disabledReason ? (
            <Tooltip content={disabledReason} size="sm" placement="top" classNames={{ content: 'max-w-[240px] text-xs' }}>
              <div>{splitRow}</div>
            </Tooltip>
          ) : splitRow}
        </div>
      </PopoverContent>
    </Popover>
  );
};
