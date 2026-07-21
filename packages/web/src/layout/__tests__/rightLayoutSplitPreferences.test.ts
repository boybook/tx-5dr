import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampRightLayoutSplitPercent,
  DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT,
  getRightLayoutPaneHeights,
  getStoredRightLayoutSplitPercent,
  RIGHT_LAYOUT_SPLIT_STORAGE_KEY,
  saveRightLayoutSplitPercent,
} from '../rightLayoutSplitPreferences';

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

describe('right layout split preferences', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub());
  });

  it('uses the default split when storage is missing or invalid', () => {
    expect(getStoredRightLayoutSplitPercent()).toBe(DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT);

    localStorage.setItem(RIGHT_LAYOUT_SPLIT_STORAGE_KEY, 'bad-value');
    expect(getStoredRightLayoutSplitPercent()).toBe(DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT);
  });

  it('clamps split values to keep both panes usable', () => {
    expect(clampRightLayoutSplitPercent({
      splitPercent: 5,
      containerHeight: 600,
    })).toBeGreaterThan(5);

    expect(clampRightLayoutSplitPercent({
      splitPercent: 95,
      containerHeight: 600,
    })).toBeLessThan(95);
  });

  it('falls back to 50/50 when the workspace is too short for two minimum panes', () => {
    expect(clampRightLayoutSplitPercent({
      splitPercent: 70,
      containerHeight: 320,
    })).toBe(DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT);
  });

  it('returns pane heights that respect the clamped split', () => {
    expect(getRightLayoutPaneHeights({
      splitPercent: 90,
      containerHeight: 600,
    })).toEqual({
      splitPercent: clampRightLayoutSplitPercent({
        splitPercent: 90,
        containerHeight: 600,
      }),
      topPaneHeightPx: 412,
      operatorPaneHeightPx: 180,
    });
  });

  it('returns a balanced split when the workspace is too short to avoid pane clipping', () => {
    expect(getRightLayoutPaneHeights({
      splitPercent: 85,
      containerHeight: 320,
    })).toEqual({
      splitPercent: DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT,
      topPaneHeightPx: 156,
      operatorPaneHeightPx: 156,
    });
  });

  it('saves a normalized split and reloads it from storage', () => {
    expect(saveRightLayoutSplitPercent(63.7)).toBe(63.7);
    expect(localStorage.getItem(RIGHT_LAYOUT_SPLIT_STORAGE_KEY)).toBe('63.7');
    expect(getStoredRightLayoutSplitPercent()).toBe(63.7);

    expect(saveRightLayoutSplitPercent(0)).toBe(1);
    expect(getStoredRightLayoutSplitPercent()).toBe(1);
  });
});
