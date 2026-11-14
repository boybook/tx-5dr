import { useCallback, useEffect, useState } from 'react';
import type {
  KeyerShortcutChangedDetail,
  KeyerShortcutPreferences,
  KeyerShortcutPreset,
} from '../utils/keyerShortcutPreferences';

interface ShortcutSlot {
  id: string;
  index: number;
}

export interface UseSlotShortcutsResult {
  /** The preference store the shortcuts are read from and saved to. */
  preferences: KeyerShortcutPreferences;
  shortcuts: Record<string, KeyerShortcutPreset>;
  /** The slot's preset, or `None`. */
  getShortcut(slotId: string): KeyerShortcutPreset;
  /** Assign a preset to a slot, clearing it from any other slot that used it. */
  setSlotShortcut(slot: ShortcutSlot, preset: KeyerShortcutPreset): void;
  /** Exchange the presets of two slots (used when slots are dragged). */
  swapSlotShortcuts(slotIdA: string, slotIdB: string): void;
}

/**
 * Per-callsign F-key presets for a message panel, kept in sync with saves made
 * elsewhere through the preference store's change event.
 *
 * @param slots all panel slots (not only the visible ones); null clears the map.
 */
export function useSlotShortcuts(
  preferences: KeyerShortcutPreferences,
  callsign: string,
  slots: ShortcutSlot[] | null | undefined,
): UseSlotShortcutsResult {
  const [shortcuts, setShortcuts] = useState<Record<string, KeyerShortcutPreset>>({});

  useEffect(() => {
    if (!callsign || !slots) {
      setShortcuts({});
      return;
    }
    setShortcuts(preferences.getPresetsForCallsign(callsign, slots));
  }, [callsign, preferences, slots]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<KeyerShortcutChangedDetail>).detail;
      if (!detail || detail.callsign !== callsign?.trim().toUpperCase()) return;
      setShortcuts(prev => ({ ...prev, [detail.slotId]: detail.preset }));
    };
    window.addEventListener(preferences.eventName, handler);
    return () => window.removeEventListener(preferences.eventName, handler);
  }, [callsign, preferences]);

  const getShortcut = useCallback(
    (slotId: string) => shortcuts[slotId] ?? preferences.none,
    [preferences, shortcuts],
  );

  const setSlotShortcut = useCallback((slot: ShortcutSlot, preset: KeyerShortcutPreset) => {
    if (!callsign) return;
    const nextShortcuts = { ...shortcuts };
    const changes: Array<{ slotId: string; preset: KeyerShortcutPreset }> = [];

    if (preset !== preferences.none) {
      for (const candidate of slots ?? []) {
        if (candidate.id !== slot.id && nextShortcuts[candidate.id] === preset) {
          nextShortcuts[candidate.id] = preferences.none;
          changes.push({ slotId: candidate.id, preset: preferences.none });
        }
      }
    }

    nextShortcuts[slot.id] = preset;
    changes.push({ slotId: slot.id, preset });

    setShortcuts(nextShortcuts);
    for (const change of changes) {
      preferences.saveSlotPreset(callsign, change.slotId, change.preset);
    }
  }, [callsign, preferences, shortcuts, slots]);

  const swapSlotShortcuts = useCallback((slotIdA: string, slotIdB: string) => {
    if (!callsign) return;
    const shortcutA = shortcuts[slotIdA] ?? preferences.none;
    const shortcutB = shortcuts[slotIdB] ?? preferences.none;
    setShortcuts(prev => ({
      ...prev,
      [slotIdA]: shortcutB,
      [slotIdB]: shortcutA,
    }));
    preferences.saveSlotPreset(callsign, slotIdA, shortcutB);
    preferences.saveSlotPreset(callsign, slotIdB, shortcutA);
  }, [callsign, preferences, shortcuts]);

  return { preferences, shortcuts, getShortcut, setSlotShortcut, swapSlotShortcuts };
}
