import { createLogger } from './logger';

/**
 * Per-callsign F-key shortcut presets for keyboard-mode message slots.
 *
 * Each keyboard mode (CW, RTTY, ...) owns its own storage key and change
 * event; the stored format is `{ [CALLSIGN]: { [slotId]: preset } }`.
 */

export const KEYER_SHORTCUT_NONE = 'None';

export const KEYER_SHORTCUT_PRESETS = [
  KEYER_SHORTCUT_NONE,
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const;

export type KeyerShortcutPreset = typeof KEYER_SHORTCUT_PRESETS[number];

export interface KeyerShortcutChangedDetail {
  callsign: string;
  slotId: string;
  preset: KeyerShortcutPreset;
}

export interface KeyerShortcutPreferencesOptions {
  /** localStorage key holding the per-callsign preset map. */
  storageKey: string;
  /** Window CustomEvent name dispatched after a preset is saved. */
  eventName: string;
  /** Logger module name; defaults to `KeyerShortcutPrefs`. */
  loggerName?: string;
  /** Human label used in log messages, e.g. `CW keyer`. */
  label?: string;
}

export interface KeyerShortcutPreferences {
  readonly storageKey: string;
  readonly eventName: string;
  readonly none: typeof KEYER_SHORTCUT_NONE;
  readonly presets: typeof KEYER_SHORTCUT_PRESETS;
  getDefaultPreset(slotIndex: number): KeyerShortcutPreset;
  isPreset(value: unknown): value is KeyerShortcutPreset;
  normalizePreset(value: unknown, fallback?: KeyerShortcutPreset): KeyerShortcutPreset;
  matches(code: string, preset: KeyerShortcutPreset): boolean;
  getSlotPreset(callsign: string, slotId: string, slotIndex: number): KeyerShortcutPreset;
  getPresetsForCallsign(
    callsign: string,
    slots: Array<{ id: string; index: number }>,
  ): Record<string, KeyerShortcutPreset>;
  saveSlotPreset(callsign: string, slotId: string, preset: KeyerShortcutPreset): void;
}

type StoredShortcutMap = Record<string, Record<string, KeyerShortcutPreset>>;

function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage ?? null;
}

export function normalizeKeyerShortcutCallsign(callsign: string): string {
  return callsign.trim().toUpperCase();
}

export function getDefaultKeyerShortcutPreset(slotIndex: number): KeyerShortcutPreset {
  return slotIndex >= 1 && slotIndex <= 12
    ? (`F${slotIndex}` as KeyerShortcutPreset)
    : KEYER_SHORTCUT_NONE;
}

export function isKeyerShortcutPreset(value: unknown): value is KeyerShortcutPreset {
  return typeof value === 'string'
    && (KEYER_SHORTCUT_PRESETS as readonly string[]).includes(value);
}

export function normalizeKeyerShortcutPreset(
  value: unknown,
  fallback: KeyerShortcutPreset = KEYER_SHORTCUT_NONE,
): KeyerShortcutPreset {
  if (isKeyerShortcutPreset(value)) {
    return value;
  }

  return fallback;
}

export function matchesKeyerShortcut(code: string, preset: KeyerShortcutPreset): boolean {
  return preset !== KEYER_SHORTCUT_NONE && code === preset;
}

export function createKeyerShortcutPreferences({
  storageKey,
  eventName,
  loggerName = 'KeyerShortcutPrefs',
  label = 'keyer',
}: KeyerShortcutPreferencesOptions): KeyerShortcutPreferences {
  const logger = createLogger(loggerName);

  function readShortcutMap(): StoredShortcutMap {
    const storage = getStorage();
    if (!storage) {
      return {};
    }

    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

      const result: StoredShortcutMap = {};
      for (const [callsign, slots] of Object.entries(parsed)) {
        if (!slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
        const normalizedCallsign = normalizeKeyerShortcutCallsign(callsign);
        const normalizedSlots: Record<string, KeyerShortcutPreset> = {};
        for (const [slotId, preset] of Object.entries(slots)) {
          normalizedSlots[slotId] = normalizeKeyerShortcutPreset(preset, KEYER_SHORTCUT_NONE);
        }
        result[normalizedCallsign] = normalizedSlots;
      }
      return result;
    } catch (error) {
      logger.warn(`Failed to read ${label} shortcut preferences`, error);
      return {};
    }
  }

  function writeShortcutMap(map: StoredShortcutMap): void {
    const storage = getStorage();
    if (!storage) {
      return;
    }

    try {
      storage.setItem(storageKey, JSON.stringify(map));
    } catch (error) {
      logger.error(`Failed to save ${label} shortcut preferences`, error);
    }
  }

  function getSlotPreset(callsign: string, slotId: string, slotIndex: number): KeyerShortcutPreset {
    const normalizedCallsign = normalizeKeyerShortcutCallsign(callsign);
    const fallback = getDefaultKeyerShortcutPreset(slotIndex);
    if (!normalizedCallsign) {
      return fallback;
    }

    const map = readShortcutMap();
    return normalizeKeyerShortcutPreset(map[normalizedCallsign]?.[slotId], fallback);
  }

  return {
    storageKey,
    eventName,
    none: KEYER_SHORTCUT_NONE,
    presets: KEYER_SHORTCUT_PRESETS,
    getDefaultPreset: getDefaultKeyerShortcutPreset,
    isPreset: isKeyerShortcutPreset,
    normalizePreset: normalizeKeyerShortcutPreset,
    matches: matchesKeyerShortcut,
    getSlotPreset,
    getPresetsForCallsign(callsign, slots) {
      return Object.fromEntries(
        slots.map(slot => [slot.id, getSlotPreset(callsign, slot.id, slot.index)]),
      );
    },
    saveSlotPreset(callsign, slotId, preset) {
      const normalizedCallsign = normalizeKeyerShortcutCallsign(callsign);
      if (!normalizedCallsign) {
        return;
      }

      const map = readShortcutMap();
      const slots = map[normalizedCallsign] ?? {};
      const savedPreset = normalizeKeyerShortcutPreset(preset);
      slots[slotId] = savedPreset;
      map[normalizedCallsign] = slots;
      writeShortcutMap(map);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<KeyerShortcutChangedDetail>(
          eventName,
          { detail: { callsign: normalizedCallsign, slotId, preset: savedPreset } },
        ));
      }
    },
  };
}
