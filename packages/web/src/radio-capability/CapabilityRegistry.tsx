import { memo, useCallback, useEffect, useState, type ComponentType } from 'react';
import { Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { WSMessageType, type CapabilityDescriptor, type CapabilityState } from '@tx5dr/contracts';
import { useCapabilityDescriptors, useConnection } from '../store/radioStore';
import { useCapabilityEnvironment } from './CapabilityEnvironment';
import { getCapabilityUnavailableText, isCapabilityInteractive } from './availability';
import { capabilityTargetLabel } from './control-presentation';
import { controlEditingKey } from './control-values';
import { useCapabilitySubmission } from './useCapabilitySubmission';
import type { CapabilityComponentProps } from './control-types';
import { BooleanCapability } from './components/BooleanCapability';
import { NumberLevelCapability } from './components/NumberLevelCapability';
import { EnumCapability } from './components/EnumCapability';
import { ActionCapability } from './components/ActionCapability';
import './controls.css';

export type { CapabilityComponentProps } from './control-types';
const registry = new Map<string, ComponentType<CapabilityComponentProps>>();
const defaults = { boolean: BooleanCapability, number: NumberLevelCapability, enum: EnumCapability, action: ActionCapability };

/** Register behavior overrides, never a second component for a different container. */
export function registerCapabilityComponent(id: string, component: ComponentType<CapabilityComponentProps>): void { registry.set(id, component); }
export function getCapabilityComponent(id: string, descriptor: CapabilityDescriptor): ComponentType<CapabilityComponentProps> {
  return registry.get(id) ?? defaults[descriptor.valueType];
}

export function useCapabilityAccess(descriptor: CapabilityDescriptor, state: CapabilityState | undefined, active = true) {
  const environment = useCapabilityEnvironment();
  const { t } = useTranslation();
  const allowed = environment.canControl && (descriptor.id !== 'tci_iq_sample_rate' || environment.isAdmin);
  const busy = Boolean(descriptor.requiresIdle && environment.transmitting);
  const interactive = active && environment.connected && !busy && isCapabilityInteractive(state, allowed, descriptor.writable);
  const reason = !environment.connected ? t('radio:capability.panel.notConnected')
    : !state?.supported ? t('radio:capability.panel.notSupported')
      : busy ? t('radio:capability.panel.unavailableBusy')
        : !allowed ? t('radio:capability.quick.noPermission')
          : getCapabilityUnavailableText(state, t, descriptor.id)
            ?? (descriptor.writable ? null : t('radio:capability.quick.readOnly'));
  return { environment, interactive, reason };
}

/** Cards, pins and popovers share one renderer and edit lifetime, with optional companion inputs. */
export const CapabilityControl = memo(function CapabilityControl({ descriptor, state, active = true, draftEditor, showSliderInput = true }: {
  descriptor: CapabilityDescriptor;
  state: CapabilityState | undefined;
  active?: boolean;
  draftEditor?: CapabilityComponentProps['draftEditor'];
  showSliderInput?: boolean;
}) {
  const { t } = useTranslation();
  const { environment, interactive, reason } = useCapabilityAccess(descriptor, state, active);
  const Component = getCapabilityComponent(descriptor.id, descriptor);
  const onWrite = useCallback<CapabilityComponentProps['onWrite']>((_id, value, action) => {
    if (interactive) return environment.write(descriptor, value, action);
  }, [descriptor, environment.write, interactive]);
  const submission = useCapabilitySubmission({ state, enabled: interactive, scope: `${environment.scope}:${controlEditingKey(descriptor)}`, onWrite });
  const target = capabilityTargetLabel(descriptor, t);
  const writeError = submission.timedOut ? t('radio:capability.quick.confirmationTimeout') : submission.error;
  const summary = [t(descriptor.labelI18nKey), target, descriptor.descriptionI18nKey ? t(descriptor.descriptionI18nKey) : null,
    reason, state?.lastError, writeError, submission.pending ? t('radio:capability.quick.awaitingConfirmation') : null].filter(Boolean).join(' · ');
  const control = <span className="cap-item" data-capability-id={descriptor.id} aria-busy={submission.pending}>
      <Component key={`${environment.scope}:${controlEditingKey(descriptor)}`} capabilityId={descriptor.id} descriptor={descriptor}
        state={environment.connected ? submission.displayState : undefined} interactive={interactive} scope={environment.scope} onWrite={submission.write} draftEditor={draftEditor} showSliderInput={showSliderInput} tooltipContent={summary} />
      {descriptor.target?.scope === 'global' && <span className="text-[11px] text-default-500">{t('radio:capability.panel.targetGlobal')}</span>}
      {(state?.availability === 'unavailable' || state?.lastError) && <span className="text-warning-600 text-[11px]" aria-label={reason ?? state.lastError}>{t('radio:capability.quick.unavailable')}</span>}
      {submission.error && !state?.lastError && <span className="text-warning-600 text-[11px]">{t('radio:capability.quick.unconfirmed')}</span>}
    </span>;
  // Numeric controls separate the slider value tooltip from capability details.
  if (Component === NumberLevelCapability) return control;
  return <Tooltip content={summary} delay={350} closeDelay={0} size="sm" classNames={{ content: 'max-w-[300px] text-xs' }}>
    {control}
  </Tooltip>;
});

/** Existing compound operating-state UIs share this same guarded writer. */
export function useCapabilityWriter(): CapabilityComponentProps['onWrite'] {
  const environment = useCapabilityEnvironment();
  const descriptors = useCapabilityDescriptors();
  return useCallback((id, value, action) => { const descriptor = descriptors.get(id); if (descriptor) return environment.write(descriptor, value, action); }, [descriptors, environment.write]);
}

export function useCapabilityRefresher(): { refresh: () => void; isRefreshing: boolean } {
  const connection = useConnection();
  const { connected, scope } = useCapabilityEnvironment();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const wsClient = connection.state.radioService?.wsClientInstance;
  useEffect(() => { setIsRefreshing(false); }, [scope, connected]);
  useEffect(() => {
    if (!wsClient || !isRefreshing) return;
    const complete = () => setIsRefreshing(false);
    wsClient.onWSEvent('radioCapabilityList', complete);
    const timeout = setTimeout(complete, 10000);
    return () => { clearTimeout(timeout); wsClient.offWSEvent('radioCapabilityList', complete); };
  }, [wsClient, isRefreshing]);
  const refresh = useCallback(() => {
    if (!wsClient || !connected || isRefreshing) return;
    setIsRefreshing(true); wsClient.send(WSMessageType.REFRESH_RADIO_CAPABILITIES, {});
  }, [wsClient, connected, isRefreshing]);
  return { refresh, isRefreshing };
}
