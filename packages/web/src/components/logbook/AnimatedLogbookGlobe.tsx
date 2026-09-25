import React, { useEffect, useRef, useState } from 'react';

const EXPAND_FALLBACK_MS = 800;

export default function AnimatedLogbookGlobe({ visible, children }: {
  visible: boolean;
  children: (drawingActive: boolean) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(visible);
  const [drawingActive, setDrawingActive] = useState(visible);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wasVisibleRef = useRef(visible);
  const fallbackRef = useRef<number | null>(null);

  useEffect(() => {
    if (containerRef.current) containerRef.current.inert = !visible;
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (fallbackRef.current !== null) {
      window.clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
    if (!visible) {
      setDrawingActive(false);
      setExpanded(false);
      return;
    }
    if (wasVisible) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const frame = requestAnimationFrame(() => {
      setExpanded(true);
      if (reduceMotion) setDrawingActive(true);
      else fallbackRef.current = window.setTimeout(() => setDrawingActive(true), EXPAND_FALLBACK_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    };
  }, [visible]);

  const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (!visible || !expanded || event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') return;
    if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
    fallbackRef.current = null;
    setDrawingActive(true);
  };

  return (
    <div
      ref={containerRef}
      data-logbook-globe-transition={expanded ? 'expanded' : 'collapsed'}
      data-globe-drawing={drawingActive ? 'active' : 'paused'}
      aria-hidden={!visible}
      onTransitionEnd={handleTransitionEnd}
      className={`grid transition-[grid-template-rows,opacity] duration-[420ms] ease-in-out motion-reduce:transition-none ${
        expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      }`}
    >
      <div className="min-h-0 overflow-hidden">{children(drawingActive)}</div>
    </div>
  );
}
