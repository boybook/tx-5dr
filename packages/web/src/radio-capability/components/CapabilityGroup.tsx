import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { api } from '@tx5dr/core';
import type { CapabilityDescriptor, CapabilityValue } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { useCapabilityStates } from '../../store/radioStore';
import { useCan } from '../../store/authStore';
import { getApiBaseUrl } from '../../utils/config';
import { createLogger } from '../../utils/logger';
import { getPanelComponent } from '../CapabilityRegistry';
import { isCapabilityInteractive } from '../availability';
import { buildCapabilityGroupPayload, getCapabilityGroupValues } from '../group-values';
import { formatCapabilityNumber, fromDisplayNumber, toDisplayNumber, toDisplayStep } from '../display-utils';

const logger = createLogger('CapabilityGroup');

export function CapabilityGroupPanel({ descriptors }: { descriptors: CapabilityDescriptor[] }) {
  const { t } = useTranslation();
  const states = useCapabilityStates();
  const canControl = useCan('execute', 'RadioControl');
  const [draft, setDraft] = useState<Record<string, CapabilityValue>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onEdit = useCallback((id: string, value?: CapabilityValue) => {
    if (value !== undefined) { setDraft((previous) => ({ ...previous, [id]: value })); setFailed(false); }
  }, []);
  const actual = getCapabilityGroupValues(descriptors, states);
  const values = { ...actual, ...draft };
  for (const d of descriptors) {
    if (d.valueType === 'number' && typeof draft[d.id] === 'string') {
      const input = String(draft[d.id]).trim();
      values[d.id] = input ? fromDisplayNumber(Number(input), d) : NaN;
    }
  }
  const enabled = descriptors.every((d) => isCapabilityInteractive(states.get(d.id), canControl, d.writable));
  const complete = descriptors.every((d) => Object.prototype.hasOwnProperty.call(values, d.id)
    && (d.valueType !== 'number' || typeof values[d.id] === 'number' && Number.isFinite(values[d.id])));
  const dirty = Object.keys(draft).length > 0;
  const renderedDescriptors = useMemo(() => descriptors.map((d) => pending ? { ...d, writable: false } : d), [descriptors, pending]);

  const apply = async () => {
    if (!enabled || !complete || !dirty || pending) return;
    setPending(true); setFailed(false);
    try {
      await api.writeRadioCapabilityGroup(buildCapabilityGroupPayload(descriptors, values), getApiBaseUrl());
    } catch (error) {
      logger.warn('Radio parameter group was not applied', error);
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) { setPending(false); setDraft({}); }
    }
  };

  return <div className="space-y-3">
    {renderedDescriptors.map((d) => {
      if (d.valueType === 'number') {
        const limits = d.range ?? d.limits;
        const current = actual[d.id];
        const text = draft[d.id] !== undefined ? String(draft[d.id]) : typeof current === 'number' ? String(toDisplayNumber(current, d)) : '';
        return <Input key={d.id} size="sm" type="number" label={t(d.labelI18nKey)} value={text}
          onValueChange={(value) => onEdit(d.id, value)}
          min={limits?.min === undefined ? undefined : toDisplayNumber(limits.min, d)}
          max={limits?.max === undefined ? undefined : toDisplayNumber(limits.max, d)}
          step={toDisplayStep(limits?.step ?? 1, d)}
          description={typeof current === 'number' ? formatCapabilityNumber(current, d)
            : t(states.get(d.id)?.supported ? 'radio:capability.panel.unknownState' : 'radio:capability.panel.notSupported')}
          isDisabled={pending || !isCapabilityInteractive(states.get(d.id), canControl, d.writable)} />;
      }
      const Component = getPanelComponent(d.id, d);
      const state = states.get(d.id);
      if (!Component) return null;
      return <Component key={d.id} capabilityId={d.id} descriptor={d}
        state={state ? { ...state, value: values[d.id] ?? null } : undefined} onWrite={onEdit} />;
    })}
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="light" isDisabled={!dirty || pending} onPress={() => { setDraft({}); setFailed(false); }}>{t('radio:capability.panel.cancelGroup')}</Button>
      <Button size="sm" color="primary" isLoading={pending} isDisabled={!enabled || !complete || !dirty || pending} onPress={() => { void apply(); }}>{t('radio:capability.panel.applyGroup')}</Button>
    </div>
    {failed && <p role="alert" className="text-xs text-danger">{t('radio:capability.panel.groupFailed')}</p>}
  </div>;
}
