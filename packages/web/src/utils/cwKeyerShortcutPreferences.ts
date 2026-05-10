import { createLogger } from './logger';

const logger = createLogger('CWKeyerShortcutPrefs');

const STORAGE_KEY = 'tx5dr_cw_keyer_shortcut_presets';

export const CW_KEYER_SHORTCUT_CHANGED_EVENT = 'cwKeyerShortcutChanged';
export const CW_KEYER_SHORTCUT_NONE = 'None';

export const CW_KEYER_SHORTCUT_PRESETS = [
  CW_KEYER_SHORTCUT_NONE,
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

export type CWKeyerShortcutPreset = typeof CW_KEYER_SHORTCUT_PRESETS[number];

export interface CWKeyerShortcutChangedDetail {
  callsign: string;
  slotId: string;
  preset: CWKeyerShortcutPreset;
}

type StoredShortcutMap = Record<string, Record<string, CWKeyerShortcutPreset>>;

function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage ?? null;
}

function normalizeCallsign(callsign: string): string {
  return callsign.trim().toUpperCase();
}

function readShortcutMap(): StoredShortcutMap {
  const storage = getStorage();
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: StoredShortcutMap = {};
    for (const [callsign, slots] of Object.entries(parsed)) {
      if (!slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
      const normalizedCallsign = normalizeCallsign(callsign);
      const normalizedSlots: Record<string, CWKeyerShortcutPreset> = {};
      for (const [slotId, preset] of Object.entries(slots)) {
        normalizedSlots[slotId] = normalizeCWKeyerShortcutPreset(preset, CW_KEYER_SHORTCUT_NONE);
      }
      result[normalizedCallsign] = normalizedSlots;
    }
    return result;
  } catch (error) {
    logger.warn('Failed to read CW keyer shortcut preferences', error);
    return {};
  }
}

function writeShortcutMap(map: StoredShortcutMap): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    logger.error('Failed to save CW keyer shortcut preferences', error);
  }
}

export function getDefaultCWKeyerShortcutPreset(slotIndex: number): CWKeyerShortcutPreset {
  return slotIndex >= 1 && slotIndex <= 12
    ? (`F${slotIndex}` as CWKeyerShortcutPreset)
    : CW_KEYER_SHORTCUT_NONE;
}

export function isCWKeyerShortcutPreset(value: unknown): value is CWKeyerShortcutPreset {
  return typeof value === 'string'
    && (CW_KEYER_SHORTCUT_PRESETS as readonly string[]).includes(value);
}

export function normalizeCWKeyerShortcutPreset(
  value: unknown,
  fallback: CWKeyerShortcutPreset = CW_KEYER_SHORTCUT_NONE,
): CWKeyerShortcutPreset {
  if (isCWKeyerShortcutPreset(value)) {
    return value;
  }

  return fallback;
}

export function matchesCWKeyerShortcut(code: string, preset: CWKeyerShortcutPreset): boolean {
  return preset !== CW_KEYER_SHORTCUT_NONE && code === preset;
}

export function getCWKeyerSlotShortcutPreset(
  callsign: string,
  slotId: string,
  slotIndex: number,
): CWKeyerShortcutPreset {
  const normalizedCallsign = normalizeCallsign(callsign);
  const fallback = getDefaultCWKeyerShortcutPreset(slotIndex);
  if (!normalizedCallsign) {
    return fallback;
  }

  const map = readShortcutMap();
  return normalizeCWKeyerShortcutPreset(map[normalizedCallsign]?.[slotId], fallback);
}

export function getCWKeyerShortcutPresetsForCallsign(
  callsign: string,
  slots: Array<{ id: string; index: number }>,
): Record<string, CWKeyerShortcutPreset> {
  return Object.fromEntries(
    slots.map(slot => [
      slot.id,
      getCWKeyerSlotShortcutPreset(callsign, slot.id, slot.index),
    ]),
  );
}

export function saveCWKeyerSlotShortcutPreset(
  callsign: string,
  slotId: string,
  preset: CWKeyerShortcutPreset,
): void {
  const normalizedCallsign = normalizeCallsign(callsign);
  if (!normalizedCallsign) {
    return;
  }

  const map = readShortcutMap();
  const slots = map[normalizedCallsign] ?? {};
  const savedPreset = normalizeCWKeyerShortcutPreset(preset);
  slots[slotId] = savedPreset;
  map[normalizedCallsign] = slots;
  writeShortcutMap(map);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<CWKeyerShortcutChangedDetail>(
      CW_KEYER_SHORTCUT_CHANGED_EVENT,
      { detail: { callsign: normalizedCallsign, slotId, preset: savedPreset } },
    ));
  }
}
