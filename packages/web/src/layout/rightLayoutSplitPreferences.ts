import {
  PANE_SPLIT_DIVIDER_HEIGHT_PX,
  PANE_SPLIT_MIN_PANE_HEIGHT_PX,
  clearStoredPaneSplitPercent,
  clampPaneSplitPercent,
  getPaneSplitHeights,
  hasStoredPaneSplit,
  isActivePaneSplitPointer,
  normalizePaneSplitPercent,
  readStoredPaneSplitPercent,
  saveStoredPaneSplitPercent,
  shouldPersistPaneSplit,
  shouldStartPaneSplitPointerDrag,
} from './paneSplitPreferences';

export const DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT = 50;
export const RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX = PANE_SPLIT_DIVIDER_HEIGHT_PX;
export const RIGHT_LAYOUT_MIN_PANE_HEIGHT_PX = PANE_SPLIT_MIN_PANE_HEIGHT_PX;
export const RIGHT_LAYOUT_SPLIT_STORAGE_KEY = 'tx5dr_right_layout_split_percent';

export function normalizeRightLayoutSplitPercent(
  value: unknown,
  fallback = DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT,
): number {
  return normalizePaneSplitPercent(value, fallback);
}

export function hasStoredRightLayoutSplit(): boolean {
  return hasStoredPaneSplit(RIGHT_LAYOUT_SPLIT_STORAGE_KEY);
}

export function getStoredRightLayoutSplitPercent(): number {
  return readStoredPaneSplitPercent(
    RIGHT_LAYOUT_SPLIT_STORAGE_KEY,
    DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT,
  );
}

export function saveRightLayoutSplitPercent(splitPercent: number): number {
  return saveStoredPaneSplitPercent(
    RIGHT_LAYOUT_SPLIT_STORAGE_KEY,
    splitPercent,
    DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT,
  );
}

export function clearRightLayoutSplitPercent(): void {
  clearStoredPaneSplitPercent(RIGHT_LAYOUT_SPLIT_STORAGE_KEY);
}

export function shouldPersistRightLayoutSplit(params: {
  wasDraggingSplit: boolean;
  isDraggingSplit: boolean;
}): boolean {
  return shouldPersistPaneSplit(params);
}

export function shouldStartRightLayoutSplitPointerDrag(params: {
  hasActivePointer: boolean;
  isPrimary: boolean;
  pointerType: string;
  button: number;
}): boolean {
  return shouldStartPaneSplitPointerDrag(params);
}

export function isActiveRightLayoutSplitPointer(
  activePointerId: number | null,
  pointerId: number,
): boolean {
  return isActivePaneSplitPointer(activePointerId, pointerId);
}

export function clampRightLayoutSplitPercent(params: {
  splitPercent: number;
  containerHeight: number;
  minPaneHeightPx?: number;
  dividerHeightPx?: number;
}): number {
  return clampPaneSplitPercent({
    ...params,
    minPaneHeightPx: params.minPaneHeightPx ?? RIGHT_LAYOUT_MIN_PANE_HEIGHT_PX,
    dividerHeightPx: params.dividerHeightPx ?? RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX,
  });
}

export function getRightLayoutPaneHeights(params: {
  splitPercent: number;
  containerHeight: number;
  minPaneHeightPx?: number;
  dividerHeightPx?: number;
}): {
  splitPercent: number;
  topPaneHeightPx: number;
  operatorPaneHeightPx: number;
} {
  const heights = getPaneSplitHeights({
    ...params,
    minPaneHeightPx: params.minPaneHeightPx ?? RIGHT_LAYOUT_MIN_PANE_HEIGHT_PX,
    dividerHeightPx: params.dividerHeightPx ?? RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX,
  });

  return {
    splitPercent: heights.splitPercent,
    topPaneHeightPx: heights.leadingPaneHeightPx,
    operatorPaneHeightPx: heights.trailingPaneHeightPx,
  };
}
