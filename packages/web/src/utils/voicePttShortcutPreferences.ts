import { createLogger } from './logger';

const logger = createLogger('VoicePttShortcutPrefs');

const STORAGE_KEY = 'tx5dr_voice_ptt_shortcut_preset';

export const VOICE_PTT_SHORTCUT_CHANGED_EVENT = 'voicePttShortcutChanged';

export const VOICE_PTT_SHORTCUT_PRESETS = [
  'Backquote',
  'Space',
  'Home',
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

export type VoicePttShortcutPreset = typeof VOICE_PTT_SHORTCUT_PRESETS[number];

export const DEFAULT_VOICE_PTT_SHORTCUT_PRESET: VoicePttShortcutPreset = 'Backquote';

function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage ?? null;
}

export function isVoicePttShortcutPreset(value: unknown): value is VoicePttShortcutPreset {
  return typeof value === 'string'
    && (VOICE_PTT_SHORTCUT_PRESETS as readonly string[]).includes(value);
}

export function normalizeVoicePttShortcutPreset(value: unknown): VoicePttShortcutPreset {
  if (isVoicePttShortcutPreset(value)) {
    return value;
  }

  return DEFAULT_VOICE_PTT_SHORTCUT_PRESET;
}

export function matchesVoicePttShortcut(code: string, preset: VoicePttShortcutPreset): boolean {
  return code === preset;
}

export function getVoicePttShortcutPreset(): VoicePttShortcutPreset {
  const storage = getStorage();
  if (!storage) {
    return DEFAULT_VOICE_PTT_SHORTCUT_PRESET;
  }

  try {
    return normalizeVoicePttShortcutPreset(storage.getItem(STORAGE_KEY));
  } catch (error) {
    logger.warn('Failed to read voice PTT shortcut preference', error);
    return DEFAULT_VOICE_PTT_SHORTCUT_PRESET;
  }
}

export function saveVoicePttShortcutPreset(preset: VoicePttShortcutPreset): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(STORAGE_KEY, preset);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<VoicePttShortcutPreset>(
        VOICE_PTT_SHORTCUT_CHANGED_EVENT,
        { detail: preset }
      ));
    }
  } catch (error) {
    logger.error('Failed to save voice PTT shortcut preference', error);
  }
}

export function resetVoicePttShortcutPreset(): VoicePttShortcutPreset {
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (error) {
      logger.error('Failed to reset voice PTT shortcut preference', error);
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<VoicePttShortcutPreset>(
      VOICE_PTT_SHORTCUT_CHANGED_EVENT,
      { detail: DEFAULT_VOICE_PTT_SHORTCUT_PRESET }
    ));
  }

  return DEFAULT_VOICE_PTT_SHORTCUT_PRESET;
}
