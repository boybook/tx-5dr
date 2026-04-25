import { createLogger } from './logger';

const logger = createLogger('VoiceKeyerShortcutPrefs');

const STORAGE_KEY = 'tx5dr_voice_keyer_shortcut_presets';

export const VOICE_KEYER_SHORTCUT_CHANGED_EVENT = 'voiceKeyerShortcutChanged';
export const VOICE_KEYER_SHORTCUT_NONE = 'None';

export const VOICE_KEYER_SHORTCUT_PRESETS = [
  VOICE_KEYER_SHORTCUT_NONE,
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

export type VoiceKeyerShortcutPreset = typeof VOICE_KEYER_SHORTCUT_PRESETS[number];

export interface VoiceKeyerShortcutChangedDetail {
  callsign: string;
  slotId: string;
  preset: VoiceKeyerShortcutPreset;
}

type StoredShortcutMap = Record<string, Record<string, VoiceKeyerShortcutPreset>>;

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
      const normalizedSlots: Record<string, VoiceKeyerShortcutPreset> = {};
      for (const [slotId, preset] of Object.entries(slots)) {
        normalizedSlots[slotId] = normalizeVoiceKeyerShortcutPreset(preset, VOICE_KEYER_SHORTCUT_NONE);
      }
      result[normalizedCallsign] = normalizedSlots;
    }
    return result;
  } catch (error) {
    logger.warn('Failed to read voice keyer shortcut preferences', error);
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
    logger.error('Failed to save voice keyer shortcut preferences', error);
  }
}

export function getDefaultVoiceKeyerShortcutPreset(slotIndex: number): VoiceKeyerShortcutPreset {
  return slotIndex >= 1 && slotIndex <= 12
    ? (`F${slotIndex}` as VoiceKeyerShortcutPreset)
    : VOICE_KEYER_SHORTCUT_NONE;
}

export function isVoiceKeyerShortcutPreset(value: unknown): value is VoiceKeyerShortcutPreset {
  return typeof value === 'string'
    && (VOICE_KEYER_SHORTCUT_PRESETS as readonly string[]).includes(value);
}

export function normalizeVoiceKeyerShortcutPreset(
  value: unknown,
  fallback: VoiceKeyerShortcutPreset = VOICE_KEYER_SHORTCUT_NONE,
): VoiceKeyerShortcutPreset {
  if (isVoiceKeyerShortcutPreset(value)) {
    return value;
  }

  return fallback;
}

export function matchesVoiceKeyerShortcut(code: string, preset: VoiceKeyerShortcutPreset): boolean {
  return preset !== VOICE_KEYER_SHORTCUT_NONE && code === preset;
}

export function getVoiceKeyerSlotShortcutPreset(
  callsign: string,
  slotId: string,
  slotIndex: number,
): VoiceKeyerShortcutPreset {
  const normalizedCallsign = normalizeCallsign(callsign);
  const fallback = getDefaultVoiceKeyerShortcutPreset(slotIndex);
  if (!normalizedCallsign) {
    return fallback;
  }

  const map = readShortcutMap();
  return normalizeVoiceKeyerShortcutPreset(map[normalizedCallsign]?.[slotId], fallback);
}

export function getVoiceKeyerShortcutPresetsForCallsign(
  callsign: string,
  slots: Array<{ id: string; index: number }>,
): Record<string, VoiceKeyerShortcutPreset> {
  return Object.fromEntries(
    slots.map(slot => [
      slot.id,
      getVoiceKeyerSlotShortcutPreset(callsign, slot.id, slot.index),
    ]),
  );
}

export function saveVoiceKeyerSlotShortcutPreset(
  callsign: string,
  slotId: string,
  preset: VoiceKeyerShortcutPreset,
): void {
  const normalizedCallsign = normalizeCallsign(callsign);
  if (!normalizedCallsign) {
    return;
  }

  const map = readShortcutMap();
  const slots = map[normalizedCallsign] ?? {};
  const savedPreset = normalizeVoiceKeyerShortcutPreset(preset);
  slots[slotId] = savedPreset;
  map[normalizedCallsign] = slots;
  writeShortcutMap(map);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<VoiceKeyerShortcutChangedDetail>(
      VOICE_KEYER_SHORTCUT_CHANGED_EVENT,
      { detail: { callsign: normalizedCallsign, slotId, preset: savedPreset } },
    ));
  }
}
