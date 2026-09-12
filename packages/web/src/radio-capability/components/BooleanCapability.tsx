import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../control-types';
import { capabilityShortLabel } from '../control-presentation';

export function BooleanCapability({ descriptor, capabilityId, state, interactive, onWrite, showInlineLabel = true }: CapabilityComponentProps) {
  const { t } = useTranslation();
  const known = typeof state?.value === 'boolean';
  const enabled = state?.value === true;
  const label = capabilityShortLabel(descriptor, t);
  if (!descriptor.writable) return <span className="cap-item">{showInlineLabel && <span>{label}</span>}<span>{known ? t(enabled ? 'radio:capability.quick.on' : 'radio:capability.quick.off') : '—'}</span></span>;
  return <Button size="sm" variant="flat" color={known && enabled ? 'primary' : 'default'} className="cap-button cap-value-toggle"
    aria-label={t(descriptor.labelI18nKey)} aria-pressed={known ? enabled : 'mixed'}
    isDisabled={!interactive || !known}
    onPress={() => { if (interactive && known) onWrite(capabilityId, !enabled); }}>
    {label}{!known && <span>—</span>}
  </Button>;
}
