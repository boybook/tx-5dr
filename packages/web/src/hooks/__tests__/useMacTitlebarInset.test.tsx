// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_TRAFFIC_LIGHT_RESERVED_PT,
  useMacTitlebarLeftInset,
  windowPointsToCssPixels,
} from '../useMacTitlebarInset';

const MAC_ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.100 Electron/45.3.2 Safari/537.36';

function stubEnvironment(userAgent: string, getZoomFactor?: () => number) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(userAgent.includes('Macintosh') ? 'MacIntel' : 'Win32');
  window.electronAPI = getZoomFactor
    ? ({ window: { getZoomFactor } } as unknown as typeof window.electronAPI)
    : undefined;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.electronAPI = undefined;
});

describe('windowPointsToCssPixels', () => {
  it('grows the CSS inset as the page zooms out so it still clears the native buttons', () => {
    expect(windowPointsToCssPixels(80, 1)).toBe(80);
    expect(windowPointsToCssPixels(80, 0.9)).toBe(89);
    expect(windowPointsToCssPixels(80, 0.5)).toBe(160);
    expect(windowPointsToCssPixels(80, 1.5)).toBe(54);
  });
});

describe('useMacTitlebarLeftInset', () => {
  it('returns null outside the macOS desktop app', () => {
    stubEnvironment('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45.3.2', () => 1);
    const { result } = renderHook(() => useMacTitlebarLeftInset());
    expect(result.current).toBeNull();
  });

  it('follows the page zoom factor on resize', () => {
    let zoom = 1;
    stubEnvironment(MAC_ELECTRON_UA, () => zoom);
    const { result } = renderHook(() => useMacTitlebarLeftInset());
    expect(result.current).toBe(MAC_TRAFFIC_LIGHT_RESERVED_PT);

    zoom = 0.8;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(result.current).toBe(100);
  });

  it('falls back to zoom 1 when the preload does not expose the zoom factor', () => {
    stubEnvironment(MAC_ELECTRON_UA);
    const { result } = renderHook(() => useMacTitlebarLeftInset());
    expect(result.current).toBe(MAC_TRAFFIC_LIGHT_RESERVED_PT);
  });
});
