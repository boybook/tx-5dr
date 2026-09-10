import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { UserRole, type CapabilityDescriptor, type CapabilityValue } from '@tx5dr/contracts';
import { useCapabilityDescriptors, useConnection, useProfiles, usePTTState, useRadioConnectionState } from '../store/radio/hooks';
import { useCan, useHasMinRole } from '../store/authStore';
import { controlEditingKey } from './control-values';
import { CapabilityWriteRequests } from './CapabilityWriteRequests';
import type { CapabilityWriteFeedback, CapabilityWriteOperation } from './control-types';

export interface CapabilityEnvironment {
  scope: string;
  connected: boolean;
  canControl: boolean;
  isAdmin: boolean;
  transmitting: boolean;
  profileId: string | null;
  write: (descriptor: CapabilityDescriptor, value?: CapabilityValue, action?: boolean) => CapabilityWriteOperation;
}
export const CapabilityEnvironmentContext = createContext<CapabilityEnvironment | null>(null);

/** UI edit lifetime only. All radio operations still belong to the server. */
export function CapabilityEnvironmentProvider({ children }: { children: ReactNode }) {
  const { state: connection } = useConnection();
  const { radioConnected, radioConfig } = useRadioConnectionState();
  const { activeProfileId } = useProfiles();
  const { pttStatus, tuneToneStatus } = usePTTState();
  const descriptors = useCapabilityDescriptors();
  const canControl = useCan('execute', 'RadioControl');
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const client = connection.radioService?.wsClientInstance;
  const identity = JSON.stringify([activeProfileId, radioConnected, connection.isConnected, radioConfig]);
  const lifetime = useRef({ identity, client, epoch: 0, profile: activeProfileId, descriptors, previousDescriptors: null as typeof descriptors | null });
  if (lifetime.current.identity !== identity || lifetime.current.client !== client) {
    // The initial WS snapshot can precede REST Profile hydration. Only a change
    // away from a known Profile makes its descriptors stale; hydration does not.
    const changingKnownProfile = lifetime.current.profile !== null && lifetime.current.profile !== activeProfileId;
    lifetime.current = { identity, client, epoch: lifetime.current.epoch + 1, profile: activeProfileId, descriptors,
      previousDescriptors: changingKnownProfile ? lifetime.current.descriptors : lifetime.current.previousDescriptors };
  }
  if (lifetime.current.previousDescriptors && lifetime.current.previousDescriptors !== descriptors) lifetime.current.previousDescriptors = null;
  lifetime.current.descriptors = descriptors;
  const scope = `${activeProfileId ?? ''}:${lifetime.current.epoch}`;
  const connected = Boolean(radioConnected && connection.isConnected && activeProfileId && client && !lifetime.current.previousDescriptors);
  const transmitting = pttStatus.isTransmitting || tuneToneStatus.active;
  const live = useRef({ scope, connected, canControl, isAdmin, transmitting, client, descriptors });
  const requests = useRef<CapabilityWriteRequests | null>(null);
  live.current = { scope, connected, canControl, isAdmin, transmitting, client, descriptors };
  useLayoutEffect(() => {
    live.current.connected = connected;
    return () => { live.current.connected = false; };
  }, [connected]);
  useLayoutEffect(() => {
    const currentRequests = new CapabilityWriteRequests(client);
    requests.current = currentRequests;
    return () => { currentRequests.dispose(); if (requests.current === currentRequests) requests.current = null; };
  }, [client, scope]);
  const write = useCallback((descriptor: CapabilityDescriptor, value?: CapabilityValue, action?: boolean) => {
    const current = live.current;
    const actual = current.descriptors.get(descriptor.id);
    if (current.scope !== scope || !current.connected || !current.canControl || !descriptor.writable || descriptor.writeGroup
      || !actual || controlEditingKey(actual) !== controlEditingKey(descriptor)
      || (descriptor.requiresIdle && current.transmitting) || (descriptor.id === 'tci_iq_sample_rate' && !current.isAdmin)) return Promise.resolve<CapabilityWriteFeedback>({ outcome: 'cancelled' });
    return requests.current?.write({ id: descriptor.id, value, action, sessionId: descriptor.sessionId })
      ?? Promise.resolve<CapabilityWriteFeedback>({ outcome: 'cancelled' });
  }, [scope]);
  const value = useMemo(() => ({ scope, connected, canControl, isAdmin, transmitting, profileId: activeProfileId, write }),
    [scope, connected, canControl, isAdmin, transmitting, activeProfileId, write]);
  return <CapabilityEnvironmentContext.Provider value={value}>{children}</CapabilityEnvironmentContext.Provider>;
}

export function useCapabilityEnvironment(): CapabilityEnvironment {
  const value = useContext(CapabilityEnvironmentContext);
  if (!value) throw new Error('Capability controls require CapabilityEnvironmentProvider');
  return value;
}
