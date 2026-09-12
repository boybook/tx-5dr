import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, ModalContent, ModalHeader, ModalBody, Tooltip, Popover, PopoverTrigger, PopoverContent, Input, Tabs, Tab } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotateRight, faArrowUp, faArrowDown, faXmark, faEllipsis, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { CapabilityCategory } from '@tx5dr/contracts';
import { getVisibleCapabilitySections, groupCapabilityDescriptors, splitCapabilitySectionsForColumns, type CapabilityCategorySection } from '../../../radio-capability/capability-descriptors';
import { useCapabilityRefresher } from '../../../radio-capability/CapabilityRegistry';
import { CapabilityCard } from '../../../radio-capability/components/CapabilityCard';
import { useCapabilityEnvironment } from '../../../radio-capability/CapabilityEnvironment';
import { capabilityShortLabel, capabilityTargetLabel, pinnedLabel } from '../../../radio-capability/control-presentation';
import { pinnedKey, useQuickControlPreferences } from '../../../radio-capability/quick-control-preferences';
import { useCapabilityDescriptors, useCapabilityStates, useProfiles, useRadioConnectionState } from '../../../store/radioStore';
import { PowerControlButton } from '../profile/PowerControlButton';
import '../../../radio-capability/panel.css';

interface RadioControlPanelProps { isOpen: boolean; onClose: () => void }

/** Modal contents mount only while open, so closing always discards edits. */
export function RadioControlPanel(props: RadioControlPanelProps) {
  const { scope } = useCapabilityEnvironment();
  return props.isOpen ? <OpenRadioControlPanel key={scope} {...props} /> : null;
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
  const [selectedCategory, setSelectedCategory] = useState<CapabilityCategory | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [navigationRevision, setNavigationRevision] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
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
  const category = sections.find(section => section.category === selectedCategory)?.category ?? sections[0]?.category;
  const query = isMobile ? search.trim().toLocaleLowerCase() : '';
  const shownSections = useMemo(() => sections.flatMap(section => {
    if (!query) return section.category === category ? [section] : [];
    const items = section.items.filter(entry => (entry.type === 'single' ? [entry.item] : entry.items).some(descriptor =>
      [descriptor.id, t(descriptor.labelI18nKey), capabilityShortLabel(descriptor, t),
        descriptor.descriptionI18nKey ? t(descriptor.descriptionI18nKey) : ''].join(' ').toLocaleLowerCase().includes(query)));
    return items.length ? [{ ...section, items }] : [];
  }), [sections, category, query, t]);
  const contextTarget = useMemo(() => {
    const all = [...descriptors.values()];
    const selected = all.find(descriptor => descriptor.target?.scope === 'channel')
      ?? all.find(descriptor => descriptor.target && descriptor.target.scope !== 'global');
    return selected ? capabilityTargetLabel(selected, t) : null;
  }, [descriptors, t]);
  // Replacing a view unmounts its editors and cancels their pending debounce/drafts.
  const viewKey = `${isMobile}:${isMobile ? `${category}:${query}:${navigationRevision}` : ''}`;
  useEffect(() => { if (bodyRef.current?.parentElement) bodyRef.current.parentElement.scrollTop = 0; }, [viewKey]);
  const renderSections = (list: CapabilityCategorySection[]) => list.map(section => <section key={section.category} className="space-y-2">
    {(!isMobile || query) && <h3 className="text-xs font-medium text-default-500">{t(`radio:capability.panel.${section.category}`)}</h3>}
    {section.items.map(entry => <CapabilityCard key={entry.type === 'single' ? entry.item.id : entry.groupId}
      descriptors={entry.type === 'single' ? [entry.item] : entry.items} states={states} items={preferences.items} toggle={preferences.toggle} mobile={isMobile} />)}
  </section>);
  return <Modal isOpen={isOpen} onClose={onClose} size={isMobile ? 'full' : '3xl'} scrollBehavior="inside" placement="center"
    hideCloseButton={isMobile} classNames={{ wrapper: isMobile ? 'cap-panel-viewport' : undefined }}>
    <ModalContent className={`radio-capability-controls radio-capability-panel${isMobile ? ' cap-panel-mobile' : ''}`}>
      <ModalHeader className="cap-panel-header flex flex-col gap-0.5 pb-2" data-capability-navigation={isMobile || undefined}
        onPointerDownCapture={isMobile ? () => setNavigationRevision(value => value + 1) : undefined}>
        <div className="cap-panel-toolbar flex items-center gap-2"><span className="cap-panel-title text-base">{t('radio:capability.panel.title')}</span>
          {activeProfile && <PowerControlButton profileId={activeProfile.id} compact />}
          {isMobile && <Tooltip content={t('radio:capability.panel.search')}><Button isIconOnly size="sm" variant="light" className="cap-button"
            aria-label={t('radio:capability.panel.search')} aria-expanded={searchOpen} onPress={() => { setSearchOpen(value => !value); setSearch(''); }}>
            <FontAwesomeIcon icon={faMagnifyingGlass} />
          </Button></Tooltip>}
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
              return <div className="cap-pinned-row rounded-md bg-default-100 pl-2" key={pinnedKey(ref)}>
                <span className="text-xs min-w-0 break-words">{label}</span>
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
          {isMobile && <Button isIconOnly size="sm" variant="light" className="cap-button" aria-label={t('radio:capability.panel.close')} onPress={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </Button>}
        </div>
        <span className="cap-panel-context text-xs text-default-400 font-normal">{activeProfile?.name ?? t('radio:connection.none')}{isMobile && contextTarget ? ` · ${contextTarget}` : ''}</span>
        {isMobile && searchOpen && <Input size="sm" type="search" autoFocus aria-label={t('radio:capability.panel.search')}
          placeholder={t('radio:capability.panel.searchPlaceholder')} value={search} onValueChange={setSearch} isClearable onClear={() => setSearch('')}
          classNames={{ input: 'text-base' }} />}
        {isMobile && query && <div className="cap-panel-search-results text-sm text-default-500">{t('radio:capability.panel.searchResults')}</div>}
        {isMobile && !query && sections.length > 0 && <Tabs aria-label={t('radio:capability.panel.categories')} selectedKey={category}
          onSelectionChange={key => { setSelectedCategory(key as CapabilityCategory); setSearch(''); }} variant="underlined"
          classNames={{ base: 'cap-panel-tabs', tabList: 'w-full gap-0', tab: 'min-w-0 h-11 px-1', tabContent: 'text-sm', cursor: 'bg-primary' }}>
          {sections.map(section => <Tab key={section.category} title={t(`radio:capability.panel.${section.category}`)} />)}
        </Tabs>}
      </ModalHeader>
      <ModalBody className="cap-panel-body pb-4 gap-3">
        <div ref={bodyRef}>
        {radioConfig.type === 'none' ? <p className="text-xs text-default-400">{t('radio:capability.panel.noRadioMode')}</p>
          : !environment.connected ? <p className="text-xs text-default-400">{t('radio:capability.panel.notConnected')}</p>
            : !sections.length ? <p className="text-xs text-default-400">{t('radio:capability.panel.noSupported')}</p>
              : <div key={viewKey}>
                {isMobile ? <div className="space-y-3">{shownSections.length ? renderSections(shownSections) : <p className="text-sm text-default-500" role="status">{t('radio:capability.panel.noResults')}</p>}</div>
                  : columns.right.length ? <div className="grid grid-cols-2 gap-3"><div className="space-y-3">{renderSections(columns.left)}</div><div className="space-y-3">{renderSections(columns.right)}</div></div>
                    : <div className="space-y-3">{renderSections(sections)}</div>}
              </div>}
        </div>
      </ModalBody>
    </ModalContent>
  </Modal>;
}
