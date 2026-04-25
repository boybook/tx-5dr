import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_KEYER_SHORTCUT_NONE,
  getDefaultVoiceKeyerShortcutPreset,
  getVoiceKeyerShortcutPresetsForCallsign,
  getVoiceKeyerSlotShortcutPreset,
  matchesVoiceKeyerShortcut,
  normalizeVoiceKeyerShortcutPreset,
  saveVoiceKeyerSlotShortcutPreset,
} from '../voiceKeyerShortcutPreferences';

function createStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe('voiceKeyerShortcutPreferences utils', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults slot shortcuts to matching function keys', () => {
    expect(getDefaultVoiceKeyerShortcutPreset(1)).toBe('F1');
    expect(getDefaultVoiceKeyerShortcutPreset(12)).toBe('F12');
    expect(getDefaultVoiceKeyerShortcutPreset(13)).toBe(VOICE_KEYER_SHORTCUT_NONE);
    expect(getVoiceKeyerSlotShortcutPreset('BG5DRB', '3', 3)).toBe('F3');
  });

  it('persists shortcuts per callsign and slot', () => {
    saveVoiceKeyerSlotShortcutPreset('bg5drb', '1', 'F8');
    saveVoiceKeyerSlotShortcutPreset('BG5DRB', '2', VOICE_KEYER_SHORTCUT_NONE);

    expect(getVoiceKeyerSlotShortcutPreset('BG5DRB', '1', 1)).toBe('F8');
    expect(getVoiceKeyerSlotShortcutPreset('BG5DRB', '2', 2)).toBe(VOICE_KEYER_SHORTCUT_NONE);
    expect(getVoiceKeyerSlotShortcutPreset('K1ABC', '1', 1)).toBe('F1');
  });

  it('returns shortcuts for a callsign panel', () => {
    saveVoiceKeyerSlotShortcutPreset('BG5DRB', '2', 'F9');

    expect(getVoiceKeyerShortcutPresetsForCallsign('bg5drb', [
      { id: '1', index: 1 },
      { id: '2', index: 2 },
    ])).toEqual({
      1: 'F1',
      2: 'F9',
    });
  });

  it('normalizes and matches keyboard event codes', () => {
    expect(normalizeVoiceKeyerShortcutPreset('KeyA')).toBe(VOICE_KEYER_SHORTCUT_NONE);
    expect(matchesVoiceKeyerShortcut('F6', 'F6')).toBe(true);
    expect(matchesVoiceKeyerShortcut('F6', 'F7')).toBe(false);
    expect(matchesVoiceKeyerShortcut('F6', VOICE_KEYER_SHORTCUT_NONE)).toBe(false);
  });
});

