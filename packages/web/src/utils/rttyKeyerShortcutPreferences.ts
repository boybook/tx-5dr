import { createKeyerShortcutPreferences } from './keyerShortcutPreferences';

/** RTTY macro F-key shortcut presets, stored per callsign. */
export const rttyKeyerShortcutPreferences = createKeyerShortcutPreferences({
  storageKey: 'tx5dr_rtty_keyer_shortcut_presets',
  eventName: 'rttyKeyerShortcutChanged',
  loggerName: 'RttyKeyerShortcutPrefs',
  label: 'RTTY macros',
});
