import {
  createKeyerShortcutPreferences,
  getDefaultKeyerShortcutPreset,
  isKeyerShortcutPreset,
  KEYER_SHORTCUT_NONE,
  KEYER_SHORTCUT_PRESETS,
  matchesKeyerShortcut,
  normalizeKeyerShortcutPreset,
  type KeyerShortcutChangedDetail,
  type KeyerShortcutPreset,
} from './keyerShortcutPreferences';

/** CW keyer F-key shortcut presets, stored per callsign. */
export const cwKeyerShortcutPreferences = createKeyerShortcutPreferences({
  storageKey: 'tx5dr_cw_keyer_shortcut_presets',
  eventName: 'cwKeyerShortcutChanged',
  loggerName: 'CWKeyerShortcutPrefs',
  label: 'CW keyer',
});

export const CW_KEYER_SHORTCUT_CHANGED_EVENT = cwKeyerShortcutPreferences.eventName;
export const CW_KEYER_SHORTCUT_NONE = KEYER_SHORTCUT_NONE;
export const CW_KEYER_SHORTCUT_PRESETS = KEYER_SHORTCUT_PRESETS;

export type CWKeyerShortcutPreset = KeyerShortcutPreset;
export type CWKeyerShortcutChangedDetail = KeyerShortcutChangedDetail;

export const getDefaultCWKeyerShortcutPreset = getDefaultKeyerShortcutPreset;
export const isCWKeyerShortcutPreset = isKeyerShortcutPreset;
export const normalizeCWKeyerShortcutPreset = normalizeKeyerShortcutPreset;
export const matchesCWKeyerShortcut = matchesKeyerShortcut;
export const getCWKeyerSlotShortcutPreset = cwKeyerShortcutPreferences.getSlotPreset;
export const getCWKeyerShortcutPresetsForCallsign = cwKeyerShortcutPreferences.getPresetsForCallsign;
export const saveCWKeyerSlotShortcutPreset = cwKeyerShortcutPreferences.saveSlotPreset;
