import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PANE_SPLIT_DIVIDER_HEIGHT_PX,
  clampPaneSplitPercent,
  clearStoredPaneSplitPercent,
  getPaneSplitHeights,
  hasStoredPaneSplit,
  isActivePaneSplitPointer,
  readStoredPaneSplitPercent,
  saveStoredPaneSplitPercent,
  shouldPersistPaneSplit,
  shouldStartPaneSplitPointerDrag,
} from '../layout/paneSplitPreferences';

export interface UseVerticalPaneSplitOptions {
  storageKey: string;
  defaultSplitPercent?: number;
  minPaneHeightPx?: number;
  dividerHeightPx?: number;
}

export interface UseVerticalPaneSplitResult {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  leadingPaneRef: React.MutableRefObject<HTMLDivElement | null>;
  hasCustomSplit: boolean;
  isDraggingSplit: boolean;
  splitPercent: number;
  containerHeight: number;
  leadingPaneHeightPx: number;
  trailingPaneHeightPx: number;
  handleDividerPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleDividerDoubleClick: () => void;
}

export function useVerticalPaneSplit({
  storageKey,
  defaultSplitPercent = 50,
  minPaneHeightPx = 120,
  dividerHeightPx = PANE_SPLIT_DIVIDER_HEIGHT_PX,
}: UseVerticalPaneSplitOptions): UseVerticalPaneSplitResult {
  const [splitPercent, setSplitPercent] = useState(() => (
    readStoredPaneSplitPercent(storageKey, defaultSplitPercent)
  ));
  const [hasCustomSplit, setHasCustomSplit] = useState(() => hasStoredPaneSplit(storageKey));
  const [containerHeight, setContainerHeight] = useState(0);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leadingPaneRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const dragStartYRef = useRef(0);
  const dragStartSplitPercentRef = useRef(defaultSplitPercent);
  const pendingAutoConvertRef = useRef<number | null>(null);
  const wasDraggingSplitRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return undefined;
    }

    const measure = () => {
      const nextHeight = container.clientHeight;
      setContainerHeight((currentHeight) => (
        currentHeight === nextHeight ? currentHeight : nextHeight
      ));
    };

    measure();

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure);
    if (resizeObserver) {
      resizeObserver.observe(container);
    }
    window.addEventListener('resize', measure);

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (hasCustomSplit === false || containerHeight <= 0) {
      return;
    }

    setSplitPercent((currentSplitPercent) => clampPaneSplitPercent({
      splitPercent: currentSplitPercent,
      containerHeight,
      minPaneHeightPx,
      dividerHeightPx,
    }));
  }, [containerHeight, dividerHeightPx, hasCustomSplit, minPaneHeightPx]);

  const handleDividerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const hasActivePointer = (activePointerIdRef.current === null) === false;
    const canStartDrag = shouldStartPaneSplitPointerDrag({
      hasActivePointer,
      isPrimary: event.isPrimary,
      pointerType: event.pointerType,
      button: event.button,
    });
    if (canStartDrag === false) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    dragStartYRef.current = event.clientY;

    let startSplitPercent = splitPercent;
    if (hasCustomSplit === false) {
      const container = containerRef.current;
      const leadingPane = leadingPaneRef.current;
      if (container && leadingPane) {
        const measuredContainerHeight = container.clientHeight;
        const usableHeight = Math.max(measuredContainerHeight - dividerHeightPx, 0);
        if (usableHeight > 0) {
          startSplitPercent = clampPaneSplitPercent({
            splitPercent: (leadingPane.clientHeight / usableHeight) * 100,
            containerHeight: measuredContainerHeight,
            minPaneHeightPx,
            dividerHeightPx,
          });
        }
      }
      pendingAutoConvertRef.current = startSplitPercent;
    } else {
      pendingAutoConvertRef.current = null;
    }

    dragStartSplitPercentRef.current = startSplitPercent;
    setIsDraggingSplit(true);
  }, [dividerHeightPx, hasCustomSplit, minPaneHeightPx, splitPercent]);

  const handlePointerEnd = useCallback((event: PointerEvent) => {
    const isActivePointer = isActivePaneSplitPointer(activePointerIdRef.current, event.pointerId);
    if (isActivePointer === false) {
      return;
    }

    activePointerIdRef.current = null;
    pendingAutoConvertRef.current = null;
    setIsDraggingSplit(false);
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const isActivePointer = isActivePaneSplitPointer(activePointerIdRef.current, event.pointerId);
    if (isActivePointer === false) {
      return;
    }
    if (event.buttons === 0) {
      handlePointerEnd(event);
      return;
    }

    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const measuredContainerHeight = container.clientHeight;
    if (measuredContainerHeight <= 0) {
      return;
    }

    const pendingAutoConvert = pendingAutoConvertRef.current;
    if (pendingAutoConvert === null) {
      // Already in a custom split; continue from the drag start ratio.
    } else {
      setSplitPercent(pendingAutoConvert);
      setHasCustomSplit(true);
      pendingAutoConvertRef.current = null;
    }

    const usableHeight = Math.max(measuredContainerHeight - dividerHeightPx, 0);
    if (usableHeight <= 0) {
      return;
    }

    const deltaPercent = ((event.clientY - dragStartYRef.current) / usableHeight) * 100;
    setSplitPercent(clampPaneSplitPercent({
      splitPercent: dragStartSplitPercentRef.current + deltaPercent,
      containerHeight: measuredContainerHeight,
      minPaneHeightPx,
      dividerHeightPx,
    }));
  }, [dividerHeightPx, handlePointerEnd, minPaneHeightPx]);

  useEffect(() => {
    if (isDraggingSplit === false) {
      return undefined;
    }

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerEnd);
    document.addEventListener('pointercancel', handlePointerEnd);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerEnd);
      document.removeEventListener('pointercancel', handlePointerEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [handlePointerEnd, handlePointerMove, isDraggingSplit]);

  useEffect(() => {
    const wasDraggingSplit = wasDraggingSplitRef.current;
    wasDraggingSplitRef.current = isDraggingSplit;

    const shouldPersist = shouldPersistPaneSplit({
      wasDraggingSplit,
      isDraggingSplit,
    });
    if (shouldPersist === false || hasCustomSplit === false) {
      return;
    }

    saveStoredPaneSplitPercent(storageKey, splitPercent, defaultSplitPercent);
  }, [defaultSplitPercent, hasCustomSplit, isDraggingSplit, splitPercent, storageKey]);

  const handleDividerDoubleClick = useCallback(() => {
    clearStoredPaneSplitPercent(storageKey);
    setSplitPercent(defaultSplitPercent);
    setHasCustomSplit(false);
    pendingAutoConvertRef.current = null;
  }, [defaultSplitPercent, storageKey]);

  const paneHeights = getPaneSplitHeights({
    splitPercent,
    containerHeight,
    minPaneHeightPx,
    dividerHeightPx,
  });

  return {
    containerRef,
    leadingPaneRef,
    hasCustomSplit,
    isDraggingSplit,
    splitPercent: paneHeights.splitPercent,
    containerHeight,
    leadingPaneHeightPx: paneHeights.leadingPaneHeightPx,
    trailingPaneHeightPx: paneHeights.trailingPaneHeightPx,
    handleDividerPointerDown,
    handleDividerDoubleClick,
  };
}
