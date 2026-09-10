import { memo, useMemo } from 'react';
import { Button, Card, CardBody, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSlidersH } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useCapabilityDescriptors, useCapabilityStates } from '../store/radioStore';
import { useCapabilityEnvironment } from './CapabilityEnvironment';
import { CapabilityControl } from './CapabilityRegistry';
import { CapabilityGroupControl } from './components/CapabilityGroup';
import { useQuickControlPreferences, pinnedKey, resolvePinnedDescriptors } from './quick-control-preferences';
import { pinnedLabel } from './control-presentation';

export const RadioQuickControls = memo(function RadioQuickControls({ active = true, onOpenPanel }: { active?: boolean; onOpenPanel?: () => void }) {
  const { t } = useTranslation();
  const environment = useCapabilityEnvironment();
  const descriptors = useCapabilityDescriptors();
  const states = useCapabilityStates();
  const { items } = useQuickControlPreferences(environment.profileId);
  const entries = useMemo(() => items.map(ref => ({ ref, descriptors: resolvePinnedDescriptors(ref, descriptors) })), [items, descriptors]);
  if (!items.length) return null;
  return <Card shadow="none" className="radio-capability-controls w-full mb-2 overflow-visible border border-default-200 dark:border-transparent bg-content1">
    <CardBody className="flex flex-row items-start gap-2 px-3 py-2 overflow-visible" role="group" aria-label={t('radio:capability.quick.title')}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        {entries.map(entry => entry.descriptors.length === 0 ? <Tooltip key={pinnedKey(entry.ref)} content={t('radio:capability.quick.missing')}>
          <span><Button className="cap-button" size="sm" variant="flat" isDisabled>{pinnedLabel(entry.ref, descriptors, t)} · —</Button></span>
        </Tooltip> : entry.ref.kind === 'group' ? <CapabilityGroupControl key={`${environment.scope}:${pinnedKey(entry.ref)}`} descriptors={entry.descriptors} states={states} active={active} />
          : <CapabilityControl key={`${environment.scope}:${pinnedKey(entry.ref)}`} descriptor={entry.descriptors[0]} state={states.get(entry.ref.id)} active={active} showSliderInput={false} />)}
      </div>
      <Tooltip content={t('radio:control.openRadioControl')}>
        <span className="flex shrink-0 border-l border-default-200 pl-2">
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="cap-button cap-panel-button text-default-500"
            aria-label={t('radio:control.openRadioControl')}
            aria-haspopup="dialog"
            isDisabled={!onOpenPanel}
            onPress={onOpenPanel}
          >
            <FontAwesomeIcon icon={faSlidersH} />
          </Button>
        </span>
      </Tooltip>
    </CardBody>
  </Card>;
});
