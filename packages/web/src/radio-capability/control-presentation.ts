import type { CapabilityDescriptor } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';
import type { PinnedCapabilityRef } from './quick-control-preferences';

const shortLabels = new Set(['nb', 'nr', 'auto_notch', 'apf_enabled', 'monitor_enabled', 'af_gain', 'monitor_gain', 'agc_mode',
  'rf_power', 'rf_gain', 'mic_gain', 'sql', 'sql_enabled', 'mute', 'rit_enabled', 'rit_offset', 'xit_enabled', 'xit_offset',
  'tuner_switch', 'tuner_tune', 'split_enabled', 'rx_filter_low', 'rx_filter_high', 'tx_filter_low', 'tx_filter_high', 'nb_threshold', 'nb_pulse_length']);

export function capabilityShortLabel(descriptor: Pick<CapabilityDescriptor, 'id' | 'labelI18nKey'>, t: TFunction): string {
  return shortLabels.has(descriptor.id) ? t(`radio:capability.quick.short.${descriptor.id}`) : t(descriptor.labelI18nKey);
}
export function capabilityTargetLabel(descriptor: CapabilityDescriptor, t: TFunction): string | null {
  const target = descriptor.target;
  if (!target) return null;
  if (target.scope === 'global') return t('radio:capability.panel.targetGlobal');
  if (target.scope === 'channel') return t('radio:capability.panel.targetChannel', { receiver: target.receiver + 1, channel: String.fromCharCode(65 + target.channel) });
  return t('radio:capability.panel.targetReceiver', { receiver: ('receiver' in target ? target.receiver : target.trx) + 1 });
}
export function pinnedLabel(ref: PinnedCapabilityRef, descriptors: Map<string, CapabilityDescriptor>, t: TFunction): string {
  if (ref.kind === 'group') return t(`radio:capability.quick.groups.${ref.id}`, { defaultValue: ref.id });
  const descriptor = descriptors.get(ref.id);
  return capabilityShortLabel(descriptor ?? { id: ref.id, labelI18nKey: `radio:capability.${ref.id}.label` }, t);
}
