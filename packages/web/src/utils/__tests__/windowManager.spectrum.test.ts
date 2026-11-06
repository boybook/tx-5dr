// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadWindowManager() {
  vi.resetModules();
  return import('../windowManager');
}

describe('standalone spectrum window', () => {
  beforeEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('resolves the spectrum page relative to the application base', async () => {
    const { getSpectrumPageUrl } = await loadWindowManager();
    expect(getSpectrumPageUrl('https://station.example/app/index.html'))
      .toBe('https://station.example/app/spectrum.html');
  });

  it('delegates to the Electron host window when available', async () => {
    const openSpectrumWindow = vi.fn().mockResolvedValue(undefined);
    (window as { electronAPI?: unknown }).electronAPI = { window: { openSpectrumWindow } };
    const open = vi.spyOn(window, 'open');
    const { openSpectrumWindow: openWindow } = await loadWindowManager();

    await expect(openWindow()).resolves.toBe('host-window');
    expect(openSpectrumWindow).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens one named browser tab and focuses it on repeated requests', async () => {
    const tab = { closed: false, focus: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    const { openSpectrumWindow, getSpectrumPageUrl } = await loadWindowManager();

    await expect(openSpectrumWindow()).resolves.toBe('browser-tab');
    await expect(openSpectrumWindow()).resolves.toBe('browser-tab');

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(getSpectrumPageUrl(), 'tx5dr-spectrum');
    expect(tab.focus).toHaveBeenCalledTimes(2);
  });

  it('opens a new tab after the previous spectrum tab was closed', async () => {
    const first = { closed: false, focus: vi.fn() } as unknown as Window & { closed: boolean };
    const second = { closed: false, focus: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { openSpectrumWindow } = await loadWindowManager();

    await openSpectrumWindow();
    first.closed = true;
    await openSpectrumWindow();

    expect(open).toHaveBeenCalledTimes(2);
    expect(second.focus).toHaveBeenCalledTimes(1);
  });
});
