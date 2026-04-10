import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOICE_PTT_SHORTCUT_PRESET,
  getVoicePttShortcutPreset,
  matchesVoicePttShortcut,
  normalizeVoicePttShortcutPreset,
  resetVoicePttShortcutPreset,
  saveVoicePttShortcutPreset,
} from '../voicePttShortcutPreferences';

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

describe('voicePttShortcutPreferences utils', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the default shortcut when storage is empty or invalid', () => {
    expect(getVoicePttShortcutPreset()).toBe(DEFAULT_VOICE_PTT_SHORTCUT_PRESET);
    localStorage.setItem('tx5dr_voice_ptt_shortcut_preset', 'KeyA');
    expect(getVoicePttShortcutPreset()).toBe(DEFAULT_VOICE_PTT_SHORTCUT_PRESET);
    expect(normalizeVoicePttShortcutPreset('KeyA')).toBe(DEFAULT_VOICE_PTT_SHORTCUT_PRESET);
  });

  it('persists and restores configured shortcut presets', () => {
    saveVoicePttShortcutPreset('F10');
    expect(getVoicePttShortcutPreset()).toBe('F10');

    saveVoicePttShortcutPreset('Backquote');
    expect(getVoicePttShortcutPreset()).toBe('Backquote');

    saveVoicePttShortcutPreset('Home');
    expect(getVoicePttShortcutPreset()).toBe('Home');

    saveVoicePttShortcutPreset('Space');
    expect(getVoicePttShortcutPreset()).toBe('Space');
  });

  it('resets back to the default shortcut', () => {
    saveVoicePttShortcutPreset('F9');
    expect(resetVoicePttShortcutPreset()).toBe(DEFAULT_VOICE_PTT_SHORTCUT_PRESET);
    expect(getVoicePttShortcutPreset()).toBe(DEFAULT_VOICE_PTT_SHORTCUT_PRESET);
  });

  it('matches keyboard events by code', () => {
    expect(matchesVoicePttShortcut('Backquote', 'Backquote')).toBe(true);
    expect(matchesVoicePttShortcut('Home', 'Home')).toBe(true);
    expect(matchesVoicePttShortcut('F1', 'F1')).toBe(true);
    expect(matchesVoicePttShortcut('F8', 'F8')).toBe(true);
    expect(matchesVoicePttShortcut('Space', 'Space')).toBe(true);
    expect(matchesVoicePttShortcut('KeyA', 'F8')).toBe(false);
  });
});
