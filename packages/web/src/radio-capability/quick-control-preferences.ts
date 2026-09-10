import { useSyncExternalStore } from 'react';
import type { CapabilityDescriptor } from '@tx5dr/contracts';

export type PinnedCapabilityRef = { kind: 'capability' | 'group'; id: string };
export interface QuickControlPreferences { version: 1; profiles: Record<string, PinnedCapabilityRef[]> }
export const QUICK_CONTROLS_STORAGE_KEY = 'tx5dr.radioQuickControls.v1';
const EMPTY: PinnedCapabilityRef[] = [];

export function pinnedKey(ref: PinnedCapabilityRef): string { return `${ref.kind}:${ref.id}`; }

export function decodeQuickControlPreferences(raw: string | null): QuickControlPreferences {
  const empty: QuickControlPreferences = { version: 1, profiles: {} };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1
      || !('profiles' in parsed) || !parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) return empty;
    const profiles = Object.fromEntries(Object.entries(parsed.profiles).flatMap(([id, refs]) => {
      if (!id || !Array.isArray(refs)) return [];
      const seen = new Set<string>();
      const items: PinnedCapabilityRef[] = [];
      for (const ref of refs) {
        if (!ref || typeof ref !== 'object' || (ref.kind !== 'capability' && ref.kind !== 'group') || typeof ref.id !== 'string' || !ref.id.trim()) continue;
        const item: PinnedCapabilityRef = { kind: ref.kind, id: ref.id };
        if (item.kind === 'capability' && item.id === 'tx_profile') continue;
        if (!seen.has(pinnedKey(item))) { seen.add(pinnedKey(item)); items.push(item); }
      }
      return [[id, items]];
    }));
    return { version: 1, profiles };
  } catch { return empty; }
}

/** One local layout store; it contains no radio values or connection snapshots. */
export class QuickControlPreferenceStore {
  private data: QuickControlPreferences | null = null;
  private unsaved = false;
  private listeners = new Set<() => void>();
  constructor(private storage: () => Storage | null, private events?: Pick<Window, 'addEventListener' | 'removeEventListener'>) {}

  private read() {
    try { return decodeQuickControlPreferences(this.storage()?.getItem(QUICK_CONTROLS_STORAGE_KEY) ?? null); }
    catch { return { version: 1 as const, profiles: {} }; }
  }
  getItems = (profileId: string | null): PinnedCapabilityRef[] => {
    if (!profileId) return EMPTY;
    this.data ??= this.read();
    return Object.prototype.hasOwnProperty.call(this.data.profiles, profileId) ? this.data.profiles[profileId] : EMPTY;
  };
  private notify() { this.listeners.forEach(listener => listener()); }
  private onStorage = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== QUICK_CONTROLS_STORAGE_KEY && storageEvent.key !== null) return;
    if (storageEvent.storageArea && storageEvent.storageArea !== this.storage()) return;
    this.data = decodeQuickControlPreferences(storageEvent.newValue); this.unsaved = false; this.notify();
  };
  subscribe = (listener: () => void) => {
    if (this.listeners.size === 0) {
      if (!this.unsaved) {
        const latest = this.read();
        if (JSON.stringify(latest) !== JSON.stringify(this.data)) this.data = latest;
      }
      this.events?.addEventListener('storage', this.onStorage);
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.events?.removeEventListener('storage', this.onStorage); };
  };
  private update(profileId: string | null, mutate: (items: PinnedCapabilityRef[]) => PinnedCapabilityRef[]) {
    if (!profileId) return;
    this.data ??= this.read();
    const items = mutate(this.getItems(profileId));
    this.data = { version: 1, profiles: { ...this.data.profiles, [profileId]: items } };
    try {
      const storage = this.storage();
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(QUICK_CONTROLS_STORAGE_KEY, JSON.stringify(this.data)); this.unsaved = false;
    } catch { this.unsaved = true; }
    this.notify();
  }
  toggle(profileId: string | null, ref: PinnedCapabilityRef) {
    if (ref.kind === 'capability' && ref.id === 'tx_profile') return;
    this.update(profileId, items => items.some(item => pinnedKey(item) === pinnedKey(ref))
      ? items.filter(item => pinnedKey(item) !== pinnedKey(ref)) : [...items, ref]);
  }
  move(profileId: string | null, ref: PinnedCapabilityRef, offset: -1 | 1) {
    this.update(profileId, items => {
      const index = items.findIndex(item => pinnedKey(item) === pinnedKey(ref));
      const next = index + offset;
      if (index < 0 || next < 0 || next >= items.length) return items;
      const result = [...items]; [result[index], result[next]] = [result[next], result[index]]; return result;
    });
  }
}

const store = new QuickControlPreferenceStore(
  () => typeof window === 'undefined' ? null : window.localStorage,
  typeof window === 'undefined' ? undefined : window,
);
export function useQuickControlPreferences(profileId: string | null) {
  const items = useSyncExternalStore(store.subscribe, () => store.getItems(profileId), () => EMPTY);
  return { items, toggle: (ref: PinnedCapabilityRef) => store.toggle(profileId, ref), move: (ref: PinnedCapabilityRef, offset: -1 | 1) => store.move(profileId, ref, offset) };
}

export function capabilityPin(descriptor: CapabilityDescriptor): PinnedCapabilityRef | null {
  if (descriptor.id === 'tx_profile') return null;
  return descriptor.writeGroup ? { kind: 'group', id: descriptor.writeGroup.id } : { kind: 'capability', id: descriptor.id };
}

export function resolvePinnedDescriptors(ref: PinnedCapabilityRef, descriptors: Map<string, CapabilityDescriptor>): CapabilityDescriptor[] {
  if (ref.kind === 'capability') {
    const descriptor = descriptors.get(ref.id);
    return descriptor && !descriptor.writeGroup && descriptor.id !== 'tx_profile' ? [descriptor] : [];
  }
  const first = Array.from(descriptors.values()).find(descriptor => descriptor.writeGroup?.id === ref.id);
  const members = first?.writeGroup?.members ?? [];
  const resolved = members.map(id => descriptors.get(id));
  return resolved.length > 0 && resolved.every((d): d is CapabilityDescriptor => Boolean(d && d.writeGroup?.id === ref.id && d.sessionId === first?.sessionId)) ? resolved : [];
}
