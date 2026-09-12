import { Button, ButtonGroup, Select, SelectItem } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../control-types';
import { capabilityShortLabel } from '../control-presentation';
import { formatCapabilityOption } from '../display-utils';

export function EnumCapability({ descriptor, capabilityId, state, interactive, onWrite, showInlineLabel = true }: CapabilityComponentProps) {
  const { t } = useTranslation();
  const options = descriptor.options ?? [];
  const selected = state?.value == null ? null : String(state.value);
  const current = options.find(option => String(option.value) === selected);
  const label = capabilityShortLabel(descriptor, t);
  const choose = (key: string) => {
    const option = options.find(item => String(item.value) === key);
    if (interactive && option && selected !== key) onWrite(capabilityId, option.value);
  };
  if (!descriptor.writable) return <span className="cap-item">{showInlineLabel && <span>{label}</span>}<span>{current ? formatCapabilityOption(current, descriptor, t) : state?.value ?? '—'}</span></span>;
  return <span className="cap-item">
    {showInlineLabel && <span className="cap-label text-default-500">{label}</span>}
    {options.length > 0 && options.length <= 4 ? <ButtonGroup size="sm" variant="flat" className="flex-wrap gap-px" aria-label={t(descriptor.labelI18nKey)}>
      {options.map(option => <Button key={String(option.value)} className="cap-button cap-segment cap-value-toggle" color={String(option.value) === selected ? 'primary' : 'default'}
        aria-pressed={String(option.value) === selected} isDisabled={!interactive}
        onPress={() => choose(String(option.value))}>{formatCapabilityOption(option, descriptor, t)}</Button>)}
    </ButtonGroup> : <Select size="sm" aria-label={t(descriptor.labelI18nKey)} disallowEmptySelection
      classNames={{ base: 'cap-select', trigger: 'cap-select-trigger', innerWrapper: 'w-full', value: 'cap-select-value', selectorIcon: 'right-1 w-3 h-3' }}
      style={{ width: `calc(${Math.min(26, Math.max(6, ...options.map(o => formatCapabilityOption(o, descriptor, t).length)))}ch + 34px)` }}
      selectedKeys={current ? [String(current.value)] : []} placeholder="—" isDisabled={!interactive || !options.length}
      onSelectionChange={keys => { if (keys !== 'all') { const key = [...keys][0]; if (key != null) choose(String(key)); } }}>
      {options.map(option => <SelectItem key={String(option.value)}>{formatCapabilityOption(option, descriptor, t)}</SelectItem>)}
    </Select>}
    {!descriptor.readable && state?.meta?.acknowledgement === 'sent' && <span className="text-[11px] text-default-500">{t('radio:capability.panel.sent')}</span>}
  </span>;
}
