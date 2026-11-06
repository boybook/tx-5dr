// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'spectrum-display-collapsed';

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

async function loadPauseModule() {
  vi.resetModules();
  return import('../spectrumSubscriptionPause');
}

describe('spectrum subscription pause scope', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub());
  });

  it('follows the persisted workspace collapse preference by default', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const pause = await loadPauseModule();

    expect(pause.isSpectrumSubscriptionPaused()).toBe(true);
    pause.setSpectrumSubscriptionPaused(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('keeps a standalone page subscribed and leaves the workspace preference untouched', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const pause = await loadPauseModule();

    pause.detachSpectrumSubscriptionPauseFromWorkspace();
    expect(pause.isSpectrumSubscriptionPaused()).toBe(false);
    expect(pause.readSpectrumSubscriptionPaused()).toBe(false);

    pause.setSpectrumSubscriptionPaused(true);
    expect(pause.isSpectrumSubscriptionPaused()).toBe(true);
    expect(pause.readSpectrumSubscriptionPaused()).toBe(true);

    pause.setSpectrumSubscriptionPaused(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });
});
