// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWebSocketClientInstanceId } from '../wsClientInstance';

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

describe('WebSocket client instance id', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', createStorageStub());
  });

  it('keeps one id across reloads of the same page', () => {
    const first = getWebSocketClientInstanceId('/');
    expect(first).toMatch(/^main-/);
    expect(getWebSocketClientInstanceId('/index.html')).toBe(first);
  });

  it('does not reuse the workspace id in a spectrum tab that inherited its session storage', () => {
    // window.open copies the opener's sessionStorage into the new tab.
    const workspaceId = getWebSocketClientInstanceId('/');
    const spectrumId = getWebSocketClientInstanceId('/spectrum.html');

    expect(spectrumId).toMatch(/^spectrum-/);
    expect(spectrumId).not.toBe(workspaceId);
    expect(getWebSocketClientInstanceId('/spectrum.html')).toBe(spectrumId);
  });
});
