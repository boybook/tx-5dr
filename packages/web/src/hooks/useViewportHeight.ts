import { useEffect, useState } from 'react';

const VIEWPORT_HEIGHT_VAR = '--app-viewport-height';

function readViewportHeight(): number {
  if (typeof window === 'undefined') {
    return 0;
  }

  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

function writeViewportHeight(value: number): void {
  if (typeof document === 'undefined' || value <= 0) {
    return;
  }

  document.documentElement.style.setProperty(VIEWPORT_HEIGHT_VAR, `${value}px`);
}

function subscribeViewport(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const visualViewport = window.visualViewport;

  window.addEventListener('resize', listener);
  window.addEventListener('orientationchange', listener);
  visualViewport?.addEventListener('resize', listener);
  visualViewport?.addEventListener('scroll', listener);

  return () => {
    window.removeEventListener('resize', listener);
    window.removeEventListener('orientationchange', listener);
    visualViewport?.removeEventListener('resize', listener);
    visualViewport?.removeEventListener('scroll', listener);
  };
}

export function useViewportHeightCssVar(): void {
  useEffect(() => {
    let frameId: number | null = null;

    const updateViewportHeight = () => {
      frameId = null;
      writeViewportHeight(readViewportHeight());
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(updateViewportHeight);
    };

    scheduleUpdate();

    const unsubscribe = subscribeViewport(scheduleUpdate);

    return () => {
      unsubscribe();

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);
}

export function useViewportHeightValue(): number {
  const [viewportHeight, setViewportHeight] = useState(() => readViewportHeight());

  useEffect(() => {
    let frameId: number | null = null;

    const updateViewportHeight = () => {
      frameId = null;
      const nextHeight = readViewportHeight();
      writeViewportHeight(nextHeight);
      setViewportHeight(prevHeight => (prevHeight === nextHeight ? prevHeight : nextHeight));
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(updateViewportHeight);
    };

    scheduleUpdate();

    const unsubscribe = subscribeViewport(scheduleUpdate);

    return () => {
      unsubscribe();

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  return viewportHeight;
}
