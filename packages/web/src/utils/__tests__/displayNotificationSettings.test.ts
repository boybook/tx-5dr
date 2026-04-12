import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_SETTINGS,
  HighlightType,
  getHighlightPriority,
  getOrderedHighlightTypes,
  resolveHighestPriorityHighlight,
  type DisplayNotificationSettings,
} from '../displayNotificationSettings';

function createSettings(): DisplayNotificationSettings {
  return {
    enabled: DEFAULT_DISPLAY_SETTINGS.enabled,
    highlights: {
      newGrid: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newGrid },
      newPrefix: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newPrefix },
      newCallsign: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newCallsign },
    },
  };
}

describe('displayNotificationSettings utils', () => {
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
