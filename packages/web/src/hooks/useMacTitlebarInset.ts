import { useEffect, useState } from 'react';
import { isElectron, isMacOS } from '../utils/config';

/**
 * Horizontal space, in window points, that the macOS traffic lights occupy with
 * `titleBarStyle: 'hiddenInset'`. The buttons end at about 72pt on macOS 26/27
 * (the Electron binary links the macOS 26 SDK); the rest is a small visual gap.
 */
export const MAC_TRAFFIC_LIGHT_RESERVED_PT = 80;

function readZoomFactor(): number {
  const zoomFactor = window.electronAPI?.window?.getZoomFactor?.();
  return typeof zoomFactor === 'number' && Number.isFinite(zoomFactor) && zoomFactor > 0
    ? zoomFactor
    : 1;
}

/**
 * Converts a distance in window points to CSS pixels at the given page zoom.
 * Page zoom scales CSS pixels but not the native window controls.
 */
export function windowPointsToCssPixels(points: number, zoomFactor: number): number {
  return Math.ceil(points / zoomFactor);
}

function readInset(): number | null {
  if (!isElectron() || !isMacOS()) {
    return null;
  }
  return windowPointsToCssPixels(MAC_TRAFFIC_LIGHT_RESERVED_PT, readZoomFactor());
}

/**
 * Left inset, in CSS pixels, that keeps content at the window's left edge clear of
 * the macOS traffic lights. Returns null outside the macOS desktop app.
 * Page zoom changes the CSS viewport, so the window `resize` event covers it.
 */
export function useMacTitlebarLeftInset(): number | null {
  const [inset, setInset] = useState<number | null>(readInset);

  useEffect(() => {
    if (!isElectron() || !isMacOS()) {
      return;
    }
    const update = () => setInset(readInset());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return inset;
}
