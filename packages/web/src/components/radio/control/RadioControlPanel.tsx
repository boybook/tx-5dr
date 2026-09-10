import { memo, useEffect, useMemo, useState } from 'react';
import { Button, Modal, ModalContent, ModalHeader, ModalBody, Tooltip, Popover, PopoverTrigger, PopoverContent } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotateRight, faThumbtack, faArrowUp, faArrowDown, faXmark, faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';
import { getVisibleCapabilitySections, groupCapabilityDescriptors, splitCapabilitySectionsForColumns, type CapabilityCategorySection } from '../../../radio-capability/capability-descriptors';
import { CapabilityControl, useCapabilityRefresher } from '../../../radio-capability/CapabilityRegistry';
import { CapabilityGroupControl } from '../../../radio-capability/components/CapabilityGroup';
import { useCapabilityEnvironment } from '../../../radio-capability/CapabilityEnvironment';
import { capabilityTargetLabel, pinnedLabel } from '../../../radio-capability/control-presentation';
import { capabilityPin, pinnedKey, useQuickControlPreferences, type PinnedCapabilityRef } from '../../../radio-capability/quick-control-preferences';
import { useCapabilityDescriptors, useCapabilityStates, useProfiles, useRadioConnectionState } from '../../../store/radioStore';
import { PowerControlButton } from '../profile/PowerControlButton';

interface RadioControlPanelProps { isOpen: boolean; onClose: () => void }

function PinButton({ descriptor, items, toggle }: {
  descriptor: CapabilityDescriptor; items: PinnedCapabilityRef[]; toggle: (ref: PinnedCapabilityRef) => void;
}) {
  const { t } = useTranslation();
  const ref = capabilityPin(descriptor);
  if (!ref) return null;
  const selected = items.some(item => pinnedKey(item) === pinnedKey(ref));
  const label = t(selected ? 'radio:capability.quick.unpin' : ref.kind === 'group' ? 'radio:capability.quick.pinGroup' : 'radio:capability.quick.pin');
  return <Tooltip content={label}><Button isIconOnly size="sm" variant="light" color="default"
    className="cap-button" aria-label={`${label} · ${t(descriptor.labelI18nKey)}`} aria-pressed={selected} onPress={() => toggle(ref)}>
    <FontAwesomeIcon icon={faThumbtack} className={selected ? 'text-foreground' : 'rotate-45 text-default-400'} />
  </Button></Tooltip>;
}

const CapabilityCard = memo(function CapabilityCard({ descriptors, states, items, toggle }: {
  descriptors: CapabilityDescriptor[]; states: Map<string, CapabilityState>; items: PinnedCapabilityRef[]; toggle: (ref: PinnedCapabilityRef) => void;
}) {
  const { t } = useTranslation();
  const first = descriptors[0];
  const atomic = Boolean(first.writeGroup);
  const describe = (descriptor: CapabilityDescriptor) => [capabilityTargetLabel(descriptor, t), descriptor.descriptionI18nKey ? t(descriptor.descriptionI18nKey) : null].filter(Boolean).join(' · ');
  if (atomic) return <div className="p-2 rounded-lg border border-default-200 bg-default-50/40 space-y-1">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium">{t(`radio:capability.quick.groups.${first.writeGroup!.id}`, { defaultValue: t(first.labelI18nKey) })}</span>
      <PinButton descriptor={first} items={items} toggle={toggle} />
    </div>
    <CapabilityGroupControl descriptors={descriptors} states={states} />
    {descriptors.map(descriptor => <p key={descriptor.id} className="text-[11px] leading-snug text-default-500">{describe(descriptor)}</p>)}
  </div>;
  return <div className="p-2 rounded-lg border border-default-200 bg-default-50/40 space-y-2">
    {descriptors.map(descriptor => {
      return <div key={descriptor.id} className="space-y-1">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs font-medium mr-auto">{t(descriptor.labelI18nKey)}</span>
          <CapabilityControl descriptor={descriptor} state={states.get(descriptor.id)} />
          <PinButton descriptor={descriptor} items={items} toggle={toggle} />
        </div>
        <p className="text-[11px] leading-snug text-default-500">{describe(descriptor)}</p>
      </div>;
    })}
  </div>;
});

/** Modal contents mount only while open, so closing always discards edits. */
export function RadioControlPanel(props: RadioControlPanelProps) {
  return props.isOpen ? <OpenRadioControlPanel {...props} /> : null;
}

function OpenRadioControlPanel({ isOpen, onClose }: RadioControlPanelProps) {
  const { t } = useTranslation();
  const { activeProfile } = useProfiles();
  const environment = useCapabilityEnvironment();
  const { radioConfig } = useRadioConnectionState();
  const descriptors = useCapabilityDescriptors();
  const states = useCapabilityStates();
  const preferences = useQuickControlPreferences(environment.profileId);
  const { refresh, isRefreshing } = useCapabilityRefresher();
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const changed = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  const groups = useMemo(() => groupCapabilityDescriptors([...descriptors.values()]), [descriptors]);
  const sections = useMemo(() => getVisibleCapabilitySections(Object.fromEntries(Object.entries(groups).map(([category, entries]) => [category,
    entries.filter(entry => entry.type === 'single' ? states.get(entry.item.id)?.supported : entry.items.some(item => states.get(item.id)?.supported)),
  ])) as typeof groups), [groups, states]);
  const columns = useMemo(() => splitCapabilitySectionsForColumns(sections), [sections]);
  const renderSections = (list: CapabilityCategorySection[]) => list.map(section => <section key={section.category} className="space-y-2">
    <h3 className="text-xs font-medium text-default-500">{t(`radio:capability.panel.${section.category}`)}</h3>
    {section.items.map(entry => <CapabilityCard key={entry.type === 'single' ? entry.item.id : entry.groupId}
      descriptors={entry.type === 'single' ? [entry.item] : entry.items} states={states} items={preferences.items} toggle={preferences.toggle} />)}
  </section>);
  return <Modal isOpen={isOpen} onClose={onClose} size={isMobile ? 'sm' : '3xl'} scrollBehavior="inside" placement="center">
    <ModalContent className="radio-capability-controls">
      <ModalHeader className="flex flex-col gap-0.5 pb-2">
        <div className="flex items-center gap-2"><span className="text-base">{t('radio:capability.panel.title')}</span>
          {activeProfile && <PowerControlButton profileId={activeProfile.id} compact />}
          <Tooltip content={t('radio:capability.panel.refresh')}><Button isIconOnly size="sm" variant="light" className="cap-button"
            aria-label={t('radio:capability.panel.refresh')} onPress={refresh} isLoading={isRefreshing} isDisabled={!environment.connected || isRefreshing}>
            <FontAwesomeIcon icon={faRotateRight} />
          </Button></Tooltip>
          {preferences.items.length > 0 && <Popover placement="bottom-start">
            <PopoverTrigger><Button isIconOnly size="sm" variant="light" className="cap-button" aria-label={t('radio:capability.quick.manage')}><FontAwesomeIcon icon={faEllipsis} /></Button></PopoverTrigger>
            <PopoverContent className="radio-capability-controls max-h-[60vh] overflow-y-auto items-stretch p-2 w-64 max-w-[calc(100vw-2rem)]">
              <section className="space-y-1.5" aria-label={t('radio:capability.quick.pinned')}>
          <h3 className="text-xs font-medium text-default-500">{t('radio:capability.quick.pinned')}</h3>
          <div className="flex flex-col gap-1.5">
            {preferences.items.map((ref, index) => {
              const label = pinnedLabel(ref, descriptors, t);
              return <div className="cap-item rounded-md bg-default-100 pl-2" key={pinnedKey(ref)}>
                <span className="text-xs mr-auto">{label}</span>
                <Button isIconOnly className="cap-button" variant="light" size="sm" aria-label={t('radio:capability.quick.moveBefore', { name: label })}
                  isDisabled={index === 0} onPress={() => preferences.move(ref, -1)}><FontAwesomeIcon icon={faArrowUp} /></Button>
                <Button isIconOnly className="cap-button" variant="light" size="sm" aria-label={t('radio:capability.quick.moveAfter', { name: label })}
                  isDisabled={index === preferences.items.length - 1} onPress={() => preferences.move(ref, 1)}><FontAwesomeIcon icon={faArrowDown} /></Button>
                <Button isIconOnly className="cap-button" variant="light" size="sm" aria-label={t('radio:capability.quick.remove', { name: label })}
                  onPress={() => preferences.toggle(ref)}><FontAwesomeIcon icon={faXmark} /></Button>
              </div>;
            })}
          </div>
        </section>
            </PopoverContent>
          </Popover>}
        </div>
        <span className="text-xs text-default-400 font-normal">{activeProfile?.name ?? t('radio:connection.none')}</span>
      </ModalHeader>
      <ModalBody className="pb-4 gap-3">
        {radioConfig.type === 'none' ? <p className="text-xs text-default-400">{t('radio:capability.panel.noRadioMode')}</p>
          : !environment.connected ? <p className="text-xs text-default-400">{t('radio:capability.panel.notConnected')}</p>
            : !sections.length ? <p className="text-xs text-default-400">{t('radio:capability.panel.noSupported')}</p>
              : !isMobile && columns.right.length ? <div className="grid grid-cols-2 gap-3"><div className="space-y-3">{renderSections(columns.left)}</div><div className="space-y-3">{renderSections(columns.right)}</div></div>
                : <div className="space-y-3">{renderSections(sections)}</div>}
      </ModalBody>
    </ModalContent>
  </Modal>;
}
