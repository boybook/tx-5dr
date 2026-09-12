import { memo, useId, useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faThumbtack } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';
import { CapabilityControl } from '../CapabilityRegistry';
import { CapabilityGroupControl } from './CapabilityGroup';
import { capabilityTargetLabel } from '../control-presentation';
import { capabilityPin, pinnedKey, type PinnedCapabilityRef } from '../quick-control-preferences';

interface CapabilityCardProps {
  descriptors: CapabilityDescriptor[];
  states: Map<string, CapabilityState>;
  items: PinnedCapabilityRef[];
  toggle: (ref: PinnedCapabilityRef) => void;
  mobile: boolean;
}

function PinButton({ descriptor, items, toggle }: Pick<CapabilityCardProps, 'items' | 'toggle'> & { descriptor: CapabilityDescriptor }) {
  const { t } = useTranslation();
  const ref = capabilityPin(descriptor);
  if (!ref) return null;
  const selected = items.some(item => pinnedKey(item) === pinnedKey(ref));
  const label = t(selected ? 'radio:capability.quick.unpin' : ref.kind === 'group' ? 'radio:capability.quick.pinGroup' : 'radio:capability.quick.pin');
  return <Tooltip content={label}>
    <Button isIconOnly size="sm" variant="light" color="default" className="cap-button cap-card-pin"
      aria-label={`${label} · ${t(descriptor.labelI18nKey)}`} aria-pressed={selected} data-capability-navigation onPress={() => toggle(ref)}>
      <FontAwesomeIcon icon={faThumbtack} className={selected ? 'text-foreground' : 'rotate-45 text-default-400'} />
    </Button>
  </Tooltip>;
}

function CapabilityField({ descriptors, states, items, toggle, mobile }: CapabilityCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const descriptionId = useId();
  const first = descriptors[0];
  const atomic = Boolean(first.writeGroup);
  const wide = atomic || (first.valueType !== 'boolean' && first.valueType !== 'action');
  const title = atomic
    ? t(`radio:capability.quick.groups.${first.writeGroup!.id}`, { defaultValue: t(first.labelI18nKey) })
    : t(first.labelI18nKey);
  const global = descriptors.some(descriptor => descriptor.target?.scope === 'global');
  return <div className="cap-card-field" data-wide={wide} data-atomic={atomic}>
    {mobile ? <Button variant="light" className="cap-card-title" aria-expanded={expanded} aria-controls={descriptionId}
      aria-label={t('radio:capability.panel.describe', { name: title })} onPress={() => setExpanded(value => !value)}>
      <span>{title}{global && <small className="cap-scope-badge">{t('radio:capability.panel.targetGlobalShort')}</small>}</span>
      <FontAwesomeIcon icon={faCircleInfo} className={expanded ? 'text-primary' : 'text-default-400'} />
    </Button> : <span className="cap-card-title">{title}</span>}
    <div className="cap-card-control">
      {atomic
        ? <CapabilityGroupControl descriptors={descriptors} states={states} descriptionPlacement={mobile ? 'card' : 'tooltip'} />
        : <CapabilityControl descriptor={first} state={states.get(first.id)} showInlineLabel={!mobile}
          descriptionPlacement={mobile ? 'card' : 'tooltip'} />}
    </div>
    <PinButton descriptor={first} items={items} toggle={toggle} />
    {(!mobile || expanded) && <div className="cap-card-description" id={descriptionId}
      role={mobile ? 'region' : undefined} aria-label={mobile ? t('radio:capability.panel.descriptionOf', { name: title }) : undefined}>
      {descriptors.map(descriptor => <p key={descriptor.id}>
        {atomic && mobile && <strong>{t(descriptor.labelI18nKey)} · </strong>}
        {!mobile && capabilityTargetLabel(descriptor, t) && <>{capabilityTargetLabel(descriptor, t)} · </>}
        {descriptor.descriptionI18nKey ? t(descriptor.descriptionI18nKey) : null}
      </p>)}
      {mobile && <p className="cap-card-description-target">{capabilityTargetLabel(first, t)}</p>}
    </div>}
  </div>;
}

/** The container owns labels and help; all parameter editing stays in shared controls. */
export const CapabilityCard = memo(function CapabilityCard(props: CapabilityCardProps) {
  return <div className="cap-card">
    {props.descriptors[0].writeGroup ? <CapabilityField {...props} />
      : props.descriptors.map(descriptor => <CapabilityField key={descriptor.id} {...props} descriptors={[descriptor]} />)}
  </div>;
});
