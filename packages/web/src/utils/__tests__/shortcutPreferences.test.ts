import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createShortcutBindingFromKeyboardEvent,
  DEFAULT_SHORTCUT_CONFIG,
  findShortcutConflicts,
  getShortcutConfig,
  isModifierOnlyShortcutEvent,
  isTypingShortcutTarget,
  matchesShortcutEvent,
  normalizeShortcutConfig,
  resetShortcutConfig,
  saveShortcutConfig,
} from '../shortcutPreferences';

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return init as KeyboardEvent;
}

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

describe('shortcutPreferences utils', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub());
  });

  it('returns defaults when storage is empty or invalid', () => {
    expect(getShortcutConfig()['toggle-current-operator-tx'].label).toBe('Alt+N');
    expect(getShortcutConfig()['halt-current-operator-tx'].label).toBe('Alt+H');
    expect(getShortcutConfig()['start-monitoring'].label).toBe('Alt+M');
    expect(getShortcutConfig()['stop-monitoring'].label).toBe('Alt+S');
    expect(getShortcutConfig()['cycle-operator-next'].label).toBe('Alt+O');
    expect(getShortcutConfig()['force-stop-all-transmission'].enabled).toBe(false);
    localStorage.setItem('tx5dr_shortcut_config_v1', '{bad json');
    expect(getShortcutConfig()['select-tx-6'].label).toBe('Alt+6');
  });

  it('fills newly added actions when normalizing legacy configs', () => {
    const legacyConfig = {
      'toggle-current-operator-tx': DEFAULT_SHORTCUT_CONFIG['toggle-current-operator-tx'],
      'select-tx-1': DEFAULT_SHORTCUT_CONFIG['select-tx-1'],
      'select-tx-2': DEFAULT_SHORTCUT_CONFIG['select-tx-2'],
      'select-tx-3': DEFAULT_SHORTCUT_CONFIG['select-tx-3'],
      'select-tx-4': DEFAULT_SHORTCUT_CONFIG['select-tx-4'],
      'select-tx-5': DEFAULT_SHORTCUT_CONFIG['select-tx-5'],
      'select-tx-6': DEFAULT_SHORTCUT_CONFIG['select-tx-6'],
    };

    const config = normalizeShortcutConfig(legacyConfig);
    expect(config['halt-current-operator-tx'].label).toBe('Alt+H');
    expect(config['cycle-operator-previous'].enabled).toBe(false);
    expect(config['select-tx-6'].label).toBe('Alt+6');
  });

  it('saves, normalizes, and resets shortcut config', () => {
    const config = normalizeShortcutConfig({
      ...DEFAULT_SHORTCUT_CONFIG,
      'select-tx-1': { code: 'KeyA', key: 'a', ctrlKey: true, enabled: true },
    });

    saveShortcutConfig(config);
    expect(getShortcutConfig()['select-tx-1'].label).toBe('Ctrl+A');
    expect(resetShortcutConfig()['select-tx-1'].label).toBe('Alt+1');
  });

  it('detects duplicate enabled shortcut bindings', () => {
    const config = normalizeShortcutConfig({
      ...DEFAULT_SHORTCUT_CONFIG,
      'select-tx-1': DEFAULT_SHORTCUT_CONFIG['toggle-current-operator-tx'],
    });

    expect(findShortcutConflicts(config)).toEqual([
      {
        signature: 'Alt+KeyN',
        actionIds: ['toggle-current-operator-tx', 'select-tx-1'],
      },
    ]);
  });

  it('does not report disabled default actions as conflicts', () => {
    const config = normalizeShortcutConfig(DEFAULT_SHORTCUT_CONFIG);
    expect(config['force-stop-all-transmission'].enabled).toBe(false);
    expect(findShortcutConflicts(config)).toEqual([]);
  });

  it('matches keyboard events with exact modifiers and code', () => {
    const binding = DEFAULT_SHORTCUT_CONFIG['toggle-current-operator-tx'];
    expect(matchesShortcutEvent(keyEvent({ code: 'KeyN', key: 'n', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), binding)).toBe(true);
    expect(matchesShortcutEvent(keyEvent({ code: 'KeyN', key: 'n', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true }), binding)).toBe(false);
    expect(matchesShortcutEvent(keyEvent({ code: 'KeyM', key: 'm', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), binding)).toBe(false);
  });

  it('matches default action shortcuts', () => {
    expect(matchesShortcutEvent(keyEvent({ code: 'KeyH', key: 'h', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), DEFAULT_SHORTCUT_CONFIG['halt-current-operator-tx'])).toBe(true);
    expect(matchesShortcutEvent(keyEvent({ code: 'KeyM', key: 'm', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), DEFAULT_SHORTCUT_CONFIG['start-monitoring'])).toBe(true);
    expect(matchesShortcutEvent(keyEvent({ code: 'KeyS', key: 's', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), DEFAULT_SHORTCUT_CONFIG['stop-monitoring'])).toBe(true);
    expect(matchesShortcutEvent(keyEvent({ code: 'KeyO', key: 'o', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), DEFAULT_SHORTCUT_CONFIG['cycle-operator-next'])).toBe(true);
  });

  it('requires at least one modifier when recording browser shortcuts', () => {
    expect(createShortcutBindingFromKeyboardEvent(keyEvent({ code: 'KeyN', key: 'n', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }))).toBeNull();
    expect(createShortcutBindingFromKeyboardEvent(keyEvent({ code: 'KeyN', key: 'n', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }))?.label).toBe('Alt+N');
  });

  it('ignores modifier-only keydown events while recording', () => {
    const altOnly = keyEvent({ code: 'AltLeft', key: 'Alt', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false });
    expect(isModifierOnlyShortcutEvent(altOnly)).toBe(true);
    expect(createShortcutBindingFromKeyboardEvent(altOnly)).toBeNull();
  });

  it('identifies editable shortcut targets', () => {
    expect(isTypingShortcutTarget({ tagName: 'INPUT', isContentEditable: false, closest: () => null } as unknown as EventTarget)).toBe(true);
    expect(isTypingShortcutTarget({ tagName: 'DIV', isContentEditable: true, closest: () => null } as unknown as EventTarget)).toBe(true);
    expect(isTypingShortcutTarget({ tagName: 'BUTTON', isContentEditable: false, closest: () => null } as unknown as EventTarget)).toBe(false);
  });
});
