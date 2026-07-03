export const DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT = 50;
export const RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX = 8;
export const RIGHT_LAYOUT_MIN_PANE_HEIGHT_PX = 180;
export const RIGHT_LAYOUT_SPLIT_STORAGE_KEY = 'tx5dr_right_layout_split_percent';

export function normalizeRightLayoutSplitPercent(
  value: unknown,
  fallback = DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT,
): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(99, Math.max(1, numeric));
}

function getLocalStorage(): Storage | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage ?? null;
}

export function getStoredRightLayoutSplitPercent(): number {
  try {
    const storage = getLocalStorage();
    const raw = storage?.getItem(RIGHT_LAYOUT_SPLIT_STORAGE_KEY);
    return normalizeRightLayoutSplitPercent(raw, DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT);
  } catch {
    return DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT;
  }
}

export function saveRightLayoutSplitPercent(splitPercent: number): number {
  const normalized = normalizeRightLayoutSplitPercent(splitPercent, DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT);

  try {
    const storage = getLocalStorage();
    storage?.setItem(RIGHT_LAYOUT_SPLIT_STORAGE_KEY, String(normalized));
  } catch {
    // Ignore storage write failures and keep the in-memory split.
  }

  return normalized;
}

export function shouldPersistRightLayoutSplit(params: {
  isMobile: boolean;
  isDraggingSplit: boolean;
}): boolean {
  return !params.isMobile && !params.isDraggingSplit;
}

export function shouldStartRightLayoutSplitPointerDrag(params: {
  isMobile: boolean;
  isPrimary: boolean;
  pointerType: string;
  button: number;
}): boolean {
  if (params.isMobile || !params.isPrimary) {
    return false;
  }

  if (params.pointerType === 'mouse' && params.button !== 0) {
    return false;
  }

  return true;
}

export function isActiveRightLayoutSplitPointer(
  activePointerId: number | null,
  pointerId: number,
): boolean {
  return activePointerId === pointerId;
}

export function clampRightLayoutSplitPercent(params: {
  splitPercent: number;
  containerHeight: number;
  minPaneHeightPx?: number;
  dividerHeightPx?: number;
}): number {
  const {
    splitPercent,
    containerHeight,
    minPaneHeightPx = RIGHT_LAYOUT_MIN_PANE_HEIGHT_PX,
    dividerHeightPx = RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX,
  } = params;
  const normalizedSplitPercent = normalizeRightLayoutSplitPercent(splitPercent);

  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    return normalizedSplitPercent;
  }

  const usableHeight = Math.max(containerHeight - dividerHeightPx, 0);
  if (usableHeight <= 0) {
    return normalizedSplitPercent;
  }

  if (usableHeight <= minPaneHeightPx * 2) {
    return DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT;
  }

  const minPercent = (minPaneHeightPx / usableHeight) * 100;
  return Math.min(100 - minPercent, Math.max(minPercent, normalizedSplitPercent));
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
  const {
    containerHeight,
    minPaneHeightPx = RIGHT_LAYOUT_MIN_PANE_HEIGHT_PX,
    dividerHeightPx = RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX,
  } = params;

  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    return {
      splitPercent: normalizeRightLayoutSplitPercent(params.splitPercent),
      topPaneHeightPx: 0,
      operatorPaneHeightPx: 0,
    };
  }

  const usableHeight = Math.max(containerHeight - dividerHeightPx, 0);
  const splitPercent = clampRightLayoutSplitPercent({
    splitPercent: params.splitPercent,
    containerHeight,
    minPaneHeightPx,
    dividerHeightPx,
  });
  const topPaneHeightPx = Math.round((usableHeight * splitPercent) / 100);

  return {
    splitPercent,
    topPaneHeightPx,
    operatorPaneHeightPx: Math.max(usableHeight - topPaneHeightPx, 0),
  };
}
