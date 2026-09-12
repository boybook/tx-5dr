import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { api } from '@tx5dr/core';
import type { CapabilityDescriptor, CapabilityState, CapabilityValue } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { CapabilityControl } from '../CapabilityRegistry';
import { useCapabilityEnvironment } from '../CapabilityEnvironment';
import { buildCapabilityGroupPayload, getCapabilityGroupValues } from '../group-values';
import { controlEditingKey, formatControlInput } from '../control-values';
import { fromDisplayNumber } from '../display-utils';
import { isCapabilityInteractive } from '../availability';
import { getApiBaseUrl } from '../../utils/config';
import { createLogger } from '../../utils/logger';

const logger = createLogger('CapabilityGroup');

export const CapabilityGroupControl = memo(function CapabilityGroupControl({ descriptors, states, active = true, descriptionPlacement = 'tooltip' }: {
  descriptors: CapabilityDescriptor[];
  states: Map<string, CapabilityState>;
  active?: boolean;
  descriptionPlacement?: 'tooltip' | 'card';
}) {
  const { t } = useTranslation();
  const environment = useCapabilityEnvironment();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const key = `${environment.scope}:${descriptors.map(controlEditingKey).join('|')}`;
  const enabled = active && environment.connected && environment.canControl && descriptors.every(d =>
    isCapabilityInteractive(states.get(d.id), true, d.writable) && (!d.requiresIdle || !environment.transmitting));
  const live = useRef({ key, enabled, mounted: true });
  live.current = { ...live.current, key, enabled };
  const inFlight = useRef(false);
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    live.current.mounted = true;
    setDraft({}); setPending(false); setFailed(false); inFlight.current = false;
    return () => { live.current.mounted = false; };
  }, [key, enabled]);
  const actual = getCapabilityGroupValues(descriptors, states);
  const values: Record<string, CapabilityValue> = { ...actual };
  for (const descriptor of descriptors) {
    const text = draft[descriptor.id];
    if (text !== undefined) values[descriptor.id] = text.trim() ? descriptor.display?.mode === 'percent'
      ? Number(text) / 100 : fromDisplayNumber(Number(text), descriptor) : NaN;
  }
  const dirty = Object.keys(draft).length > 0;
  let payload: ReturnType<typeof buildCapabilityGroupPayload> | null = null;
  try { payload = buildCapabilityGroupPayload(descriptors, values); } catch { /* Incomplete/invalid drafts stay local. */ }
  const apply = async () => {
    if (!enabled || !dirty || !payload || inFlight.current) return;
    const requestKey = key;
    const requestGeneration = generation.current;
    inFlight.current = true; setPending(true); setFailed(false);
    try {
      await api.writeRadioCapabilityGroup(payload, getApiBaseUrl());
    } catch (error) {
      logger.warn('Radio parameter group was not applied', error);
      if (live.current.mounted && live.current.key === requestKey && generation.current === requestGeneration) setFailed(true);
    } finally {
      if (live.current.mounted && live.current.key === requestKey && generation.current === requestGeneration) { inFlight.current = false; setPending(false); setDraft({}); }
    }
  };
  return <span className="cap-item" data-capability-group={descriptors[0]?.writeGroup?.id}>
    {descriptors.map(descriptor => <CapabilityControl key={descriptor.id} descriptor={descriptor} state={states.get(descriptor.id)} active={enabled && !pending} descriptionPlacement={descriptionPlacement}
      draftEditor={{
        text: draft[descriptor.id] ?? (typeof actual[descriptor.id] === 'number' ? formatControlInput(actual[descriptor.id] as number, descriptor) : ''),
        onChange: text => { if (enabled && !inFlight.current) { setDraft(previous => ({ ...previous, [descriptor.id]: text })); setFailed(false); } },
      }} />)}
    {dirty && <span className="cap-item">
      <Button size="sm" className="cap-button" color="primary" isDisabled={!enabled || !payload || pending} isLoading={pending} onPress={() => { void apply(); }}>{t('radio:capability.quick.apply')}</Button>
      <Button size="sm" className="cap-button" variant="light" isDisabled={pending} onPress={() => { setDraft({}); setFailed(false); }}>{t('radio:capability.panel.cancelGroup')}</Button>
    </span>}
    {dirty && !payload && <span className="text-warning-600 text-[11px]" role="status">{t('radio:capability.quick.invalidGroup')}</span>}
    {failed && <span className="text-danger text-[11px]" role="alert">{t('radio:capability.panel.groupFailed')}</span>}
  </span>;
}, (previous, next) => previous.active === next.active && previous.descriptionPlacement === next.descriptionPlacement && previous.descriptors.length === next.descriptors.length
  && previous.descriptors.every((descriptor, index) => descriptor === next.descriptors[index]
    && previous.states.get(descriptor.id) === next.states.get(descriptor.id)));
