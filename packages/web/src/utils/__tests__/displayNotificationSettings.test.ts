import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_SETTINGS,
  HighlightType,
  getDisplayNotificationSettings,
  getHighlightPriority,
  getOrderedHighlightTypes,
  isDefaultSettings,
  resetDisplayNotificationSettings,
  resolveHighestPriorityHighlight,
  type DisplayNotificationSettings,
} from '../displayNotificationSettings';

const store = new Map<string, string>();

function createSettings(): DisplayNotificationSettings {
  return {
    enabled: DEFAULT_DISPLAY_SETTINGS.enabled,
    highlights: {
      newGrid: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newGrid },
      newPrefix: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newPrefix },
      newCallsign: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newCallsign },
    },
    frameTableCycleBackgrounds: {
      light: { ...DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.light },
      dark: { ...DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.dark },
    },
  };
}

describe('displayNotificationSettings utils', () => {
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: () => undefined,
      },
    });
  });

  it('includes default FrameTable cycle backgrounds', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds).toEqual({
      light: {
        even: 'rgba(153, 255, 145, 0.2)',
        odd: 'rgba(255, 205, 148, 0.2)',
      },
      dark: {
        even: 'rgba(5, 150, 105, 0.25)',
        odd: 'rgba(217, 119, 6, 0.25)',
      },
    });
  });

  it('fills FrameTable cycle backgrounds for old stored settings', () => {
    store.set('tx5dr_display_notification_settings', JSON.stringify({
      enabled: false,
      highlights: {
        newGrid: { enabled: false, color: '#111111' },
      },
    }));

    expect(getDisplayNotificationSettings()).toEqual({
      enabled: false,
      highlights: {
        newGrid: { enabled: false, color: '#111111' },
        newPrefix: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newPrefix },
        newCallsign: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newCallsign },
      },
      frameTableCycleBackgrounds: DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds,
    });
  });

  it('resets FrameTable cycle backgrounds to defaults', () => {
    store.set('tx5dr_display_notification_settings', JSON.stringify({
      ...createSettings(),
      frameTableCycleBackgrounds: {
        light: { even: '#111111', odd: '#222222' },
        dark: { even: '#333333', odd: '#444444' },
      },
    }));

    expect(resetDisplayNotificationSettings()).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(getDisplayNotificationSettings()).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it('compares FrameTable cycle backgrounds when checking default settings', () => {
    const settings = createSettings();
    expect(isDefaultSettings(settings)).toBe(true);

    settings.frameTableCycleBackgrounds.dark.odd = '#444444';
    expect(isDefaultSettings(settings)).toBe(false);
  });

  it('orders highlight types with DXCC before grid and callsign', () => {
    expect(getOrderedHighlightTypes()).toEqual([
      HighlightType.NEW_PREFIX,
      HighlightType.NEW_GRID,
      HighlightType.NEW_CALLSIGN,
    ]);

    expect(getHighlightPriority(HighlightType.NEW_PREFIX)).toBeLessThan(
      getHighlightPriority(HighlightType.NEW_GRID),
    );
    expect(getHighlightPriority(HighlightType.NEW_GRID)).toBeLessThan(
      getHighlightPriority(HighlightType.NEW_CALLSIGN),
    );
  });

  it('prefers new DXCC when multiple novelty flags are true', () => {
    const settings = createSettings();

    expect(
      resolveHighestPriorityHighlight(
        {
          isNewDxccEntity: true,
          isNewGrid: true,
          isNewCallsign: true,
        },
        settings,
      ),
    ).toBe(HighlightType.NEW_PREFIX);
  });

  it('falls back to new grid when DXCC highlight is disabled', () => {
    const settings = createSettings();
    settings.highlights.newPrefix.enabled = false;

    expect(
      resolveHighestPriorityHighlight(
        {
          isNewDxccEntity: true,
          isNewGrid: true,
          isNewCallsign: true,
        },
        settings,
      ),
    ).toBe(HighlightType.NEW_GRID);
  });

  it('prefers new grid over new callsign when DXCC is not available', () => {
    const settings = createSettings();

    expect(
      resolveHighestPriorityHighlight(
        {
          isNewGrid: true,
          isNewCallsign: true,
        },
        settings,
      ),
    ).toBe(HighlightType.NEW_GRID);
  });

  it('falls back to new callsign when grid highlight is disabled', () => {
    const settings = createSettings();
    settings.highlights.newGrid.enabled = false;

    expect(
      resolveHighestPriorityHighlight(
        {
          isNewGrid: true,
          isNewCallsign: true,
        },
        settings,
      ),
    ).toBe(HighlightType.NEW_CALLSIGN);
  });

  it('returns null when global highlighting is disabled', () => {
    const settings = createSettings();
    settings.enabled = false;

    expect(
      resolveHighestPriorityHighlight(
        {
          isNewDxccEntity: true,
          isNewGrid: true,
          isNewCallsign: true,
        },
        settings,
      ),
    ).toBeNull();
  });
});
