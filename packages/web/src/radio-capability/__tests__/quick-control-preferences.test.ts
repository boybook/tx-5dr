import { describe, expect, it, vi } from 'vitest';
import type { CapabilityDescriptor } from '@tx5dr/contracts';
import { capabilityPin, decodeQuickControlPreferences, QuickControlPreferenceStore, QUICK_CONTROLS_STORAGE_KEY, resolvePinnedDescriptors } from '../quick-control-preferences';

const nb = { kind: 'capability' as const, id: 'nb' };
const nr = { kind: 'capability' as const, id: 'nr' };
const group = { kind: 'group' as const, id: 'rx_filter_band' };
const descriptor: CapabilityDescriptor = { id: 'nb', category: 'rf', valueType: 'boolean', readable: true, writable: true, updateMode: 'event', labelI18nKey: 'nb', hasSurfaceControl: false };
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => data.set(key, value)) } as unknown as Storage;
}

describe('quick-control preferences', () => {
  it('starts empty and rejects malformed storage', () => {
    for (const raw of [null, '', '{', '[]', '{"version":2,"profiles":{}}', '{"version":1,"profiles":null}']) expect(decodeQuickControlPreferences(raw)).toEqual({ version: 1, profiles: {} });
  });
  it('decodes an allowlist, deduplicates identities and excludes TX profiles', () => {
    const result = decodeQuickControlPreferences(JSON.stringify({ version: 1, profiles: { p: [nb, nb, { ...nr, value: true, sessionId: 'old' }, group, { kind: 'capability', id: 'tx_profile' }, { kind: 'bad', id: 'x' }] } }));
    expect(result.profiles.p).toEqual([nb, nr, group]);
  });
  it('isolates profile layouts, keeps order and persists no radio state', () => {
    const disk = storage(); const store = new QuickControlPreferenceStore(() => disk);
    store.toggle('a', nb); store.toggle('a', nr); store.toggle('b', group); store.move('a', nr, -1);
    expect(store.getItems('a')).toEqual([nr, nb]); expect(store.getItems('b')).toEqual([group]);
    expect(new QuickControlPreferenceStore(() => disk).getItems('a')).toEqual([nr, nb]);
    store.toggle('a', nr); expect(store.getItems('a')).toEqual([nb]);
    expect(JSON.parse(disk.getItem(QUICK_CONTROLS_STORAGE_KEY)!)).toEqual({ version: 1, profiles: { a: [nb], b: [group] } });
  });
  it('does not persist without a profile and retains memory when storage fails', () => {
    const store = new QuickControlPreferenceStore(() => { throw new Error('Denied'); });
    store.toggle(null, nb); expect(store.getItems(null)).toEqual([]);
    store.toggle('p', nr); store.toggle('p', nb); expect(store.getItems('p')).toEqual([nr, nb]);
    const unsub = store.subscribe(() => {}); unsub();
    expect(store.getItems('p')).toEqual([nr, nb]);
  });
  it('uses one storage listener and removes it after 100 subscribe cycles', () => {
    const events = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const store = new QuickControlPreferenceStore(() => storage(), events);
    for (let index = 0; index < 100; index++) { const a = store.subscribe(() => {}); const b = store.subscribe(() => {}); a(); b(); }
    expect(events.addEventListener).toHaveBeenCalledTimes(100); expect(events.removeEventListener).toHaveBeenCalledTimes(100);
  });
  it('applies cross-tab changes to the same live snapshot', () => {
    const events = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const store = new QuickControlPreferenceStore(() => null, events); const listener = vi.fn(); const unsubscribe = store.subscribe(listener);
    const callback = events.addEventListener.mock.calls[0][1] as (event: unknown) => void;
    callback({ key: QUICK_CONTROLS_STORAGE_KEY, newValue: JSON.stringify({ version: 1, profiles: { p: [nr] } }) });
    expect(store.getItems('p')).toEqual([nr]); expect(listener).toHaveBeenCalledOnce(); unsubscribe();
  });
  it('pins visual compound members independently but treats write groups atomically', () => {
    expect(capabilityPin({ ...descriptor, compoundGroup: 'nb' })).toEqual(nb);
    const first = { ...descriptor, id: 'rx_filter_low', writeGroup: { id: 'rx_filter_band', members: ['rx_filter_low', 'rx_filter_high'] } };
    const second = { ...first, id: 'rx_filter_high' };
    expect(capabilityPin(first)).toEqual(group); expect(capabilityPin(second)).toEqual(group);
    expect(resolvePinnedDescriptors(group, new Map([[first.id, first]]))).toEqual([]);
    expect(resolvePinnedDescriptors(group, new Map([[first.id, first], [second.id, second]]))).toEqual([first, second]);
    expect(resolvePinnedDescriptors({ kind: 'capability', id: first.id }, new Map([[first.id, first]]))).toEqual([]);
    expect(capabilityPin({ ...descriptor, id: 'tx_profile' })).toBeNull();
  });
});
