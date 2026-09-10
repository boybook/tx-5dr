import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../control-types';
import { capabilityShortLabel } from '../control-presentation';

export function ActionCapability({ descriptor, capabilityId, interactive, onWrite }: CapabilityComponentProps) {
  const { t } = useTranslation();
  return <Button size="sm" variant="bordered" className="cap-button" aria-label={t(descriptor.labelI18nKey)}
    isDisabled={!interactive} onPress={() => { if (interactive) onWrite(capabilityId, undefined, true); }}>
    {capabilityShortLabel(descriptor, t)}
  </Button>;
}
