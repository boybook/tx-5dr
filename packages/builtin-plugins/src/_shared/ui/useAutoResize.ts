/// <reference types="@tx5dr/plugin-api/bridge" />
import { useEffect } from 'react';

/**
 * Automatically reports iframe content height to the host via Bridge SDK.
 *
 * Uses a `ResizeObserver` on `document.body` and calls `tx5dr.resize()`
 * whenever the scroll height changes. Call once at the top level of every
 * plugin page component.
 */
export function useAutoResize() {
  useEffect(() => {
    const bridge = window.tx5dr;
    const report = () => {
      const h = document.body.scrollHeight;
      if (h > 0) bridge.resize(h);
    };
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    report();
    return () => observer.disconnect();
  }, []);
}
