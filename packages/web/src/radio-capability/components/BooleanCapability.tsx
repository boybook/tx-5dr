import React, { useCallback } from 'react';
import { Switch, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../CapabilityRegistry';
import { useCan } from '../../store/authStore';
import { getCapabilityUnavailableText, isCapabilityInteractive } from '../availability';

export const BooleanCapabilityPanel: React.FC<CapabilityComponentProps> = ({
  capabilityId,
  state,
  descriptor,
  onWrite,
}) => {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');
  const canWrite = descriptor.writable;
  const isInteractive = isCapabilityInteractive(state, canControl, canWrite);
  const unavailableText = getCapabilityUnavailableText(state, t, capabilityId);
  const enabled = typeof state?.value === 'boolean' ? state.value : false;

  const handleToggle = useCallback(() => {
    onWrite(capabilityId, !enabled);
  }, [capabilityId, enabled, onWrite]);

  return (
    <div className="space-y-1">
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
        </div>
        <Switch
          isSelected={enabled}
          onValueChange={handleToggle}
          isDisabled={!isInteractive}
          size="sm"
        />
      </div>
      {unavailableText && (
        <p className="text-xs text-warning-600">{unavailableText}</p>
      )}
    </div>
  );
};
