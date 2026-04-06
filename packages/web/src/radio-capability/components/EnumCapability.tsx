import React, { useMemo } from 'react';
import { Select, SelectItem, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../CapabilityRegistry';
import { useCan } from '../../store/authStore';
import { formatCapabilityOption } from '../display-utils';

export const EnumCapabilityPanel: React.FC<CapabilityComponentProps> = ({
  capabilityId,
  state,
  descriptor,
  onWrite,
}) => {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');
  const isSupported = state?.supported ?? false;
  const canWrite = descriptor.writable;
  const options = descriptor.options ?? [];

  const selectedKey = useMemo(() => {
    if (state?.value === null || state?.value === undefined) {
      return undefined;
    }
    return String(state.value);
  }, [state?.value]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-sm font-medium">{t(descriptor.labelI18nKey)}</span>
        {descriptor.descriptionI18nKey && (
          <Tooltip content={t(descriptor.descriptionI18nKey)} size="sm" placement="top" classNames={{ content: 'max-w-[240px] text-xs' }}>
            <FontAwesomeIcon icon={faCircleInfo} className="text-default-300 text-xs cursor-help" />
          </Tooltip>
        )}
      </div>

      <Select
        size="sm"
        selectedKeys={selectedKey ? [selectedKey] : []}
        onSelectionChange={(keys) => {
          const nextKey = Array.from(keys)[0];
          const option = options.find((item) => String(item.value) === String(nextKey));
          if (option) {
            onWrite(capabilityId, option.value);
          }
        }}
        isDisabled={!isSupported || !canControl || !canWrite || options.length === 0}
        aria-label={t(descriptor.labelI18nKey)}
      >
        {options.map((option) => (
          <SelectItem key={String(option.value)} value={String(option.value)}>
            {formatCapabilityOption(option, descriptor, t)}
          </SelectItem>
        ))}
      </Select>

      {!isSupported && (
        <p className="text-xs text-default-400">{t('radio:capability.panel.notSupported')}</p>
      )}
    </div>
  );
};
