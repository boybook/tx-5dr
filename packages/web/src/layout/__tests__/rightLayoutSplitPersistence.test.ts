import { afterEach, describe, expect, it } from 'vitest';

import {
  clearRightLayoutSplitPercent,
  hasStoredRightLayoutSplit,
  RIGHT_LAYOUT_SPLIT_STORAGE_KEY,
  shouldPersistRightLayoutSplit,
} from '../rightLayoutSplitPreferences';

describe('right layout split persistence gating', () => {
  it('skips persistence for initial renders and resize clamps', () => {
    expect(shouldPersistRightLayoutSplit({
      wasDraggingSplit: false,
      isDraggingSplit: false,
    })).toBe(false);
  });

  it('skips persistence while dragging', () => {
    expect(shouldPersistRightLayoutSplit({
      wasDraggingSplit: false,
      isDraggingSplit: true,
    })).toBe(false);
  });

  it('allows persistence only after a drag ends', () => {
    expect(shouldPersistRightLayoutSplit({
      wasDraggingSplit: true,
      isDraggingSplit: false,
    })).toBe(true);
  });
});

describe('hasStoredRightLayoutSplit', () => {
  const originalLocalStorage = globalThis.localStorage;

  afterEach(() => {
    if (typeof originalLocalStorage === 'undefined') {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true, writable: true });
    }
  });

  function stubLocalStorage(initial: Record<string, string>) {
    const map = new Map(Object.entries(initial));
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
      },
      configurable: true,
      writable: true,
    });
  }

  it('returns false when localStorage is unavailable', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(hasStoredRightLayoutSplit()).toBe(false);
  });

  it('returns false when no split ratio was ever stored', () => {
    stubLocalStorage({});
    expect(hasStoredRightLayoutSplit()).toBe(false);
  });

  it('returns false when the stored value is not numeric', () => {
    stubLocalStorage({ [RIGHT_LAYOUT_SPLIT_STORAGE_KEY]: 'not-a-number' });
    expect(hasStoredRightLayoutSplit()).toBe(false);
  });

  it('returns true when a split ratio was stored by a previous drag', () => {
    stubLocalStorage({ [RIGHT_LAYOUT_SPLIT_STORAGE_KEY]: '65' });
    expect(hasStoredRightLayoutSplit()).toBe(true);
  });
});

describe('clearRightLayoutSplitPercent', () => {
  it('removes the stored ratio so hasStoredRightLayoutSplit returns false again', () => {
    const map = new Map([[RIGHT_LAYOUT_SPLIT_STORAGE_KEY, '65']]);
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
        removeItem: (key: string) => { map.delete(key); },
      },
      configurable: true,
      writable: true,
    });
    try {
      expect(hasStoredRightLayoutSplit()).toBe(true);
      clearRightLayoutSplitPercent();
      expect(hasStoredRightLayoutSplit()).toBe(false);
      expect(map.has(RIGHT_LAYOUT_SPLIT_STORAGE_KEY)).toBe(false);
    } finally {
      if (typeof originalLocalStorage === 'undefined') {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true, writable: true });
      }
    }
  });
});
