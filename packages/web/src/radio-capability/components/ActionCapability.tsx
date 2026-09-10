import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../CapabilityRegistry';
import { useCan } from '../../store/authStore';
import { isCapabilityInteractive } from '../availability';

export function ActionCapabilityPanel({ capabilityId, descriptor, state, onWrite }: CapabilityComponentProps) {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');
  return <Button size="sm" variant="flat" isDisabled={!isCapabilityInteractive(state, canControl, descriptor.writable)}
    onPress={() => onWrite(capabilityId, undefined, true)}>{t(descriptor.labelI18nKey)}</Button>;
}
