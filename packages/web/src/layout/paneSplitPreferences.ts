export const DEFAULT_PANE_SPLIT_PERCENT = 50;
export const PANE_SPLIT_DIVIDER_HEIGHT_PX = 8;
export const PANE_SPLIT_MIN_PANE_HEIGHT_PX = 180;

export function normalizePaneSplitPercent(
  value: unknown,
  fallback = DEFAULT_PANE_SPLIT_PERCENT,
): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;

  if (Number.isFinite(numeric) === false) {
    return fallback;
  }

  return Math.min(99, Math.max(1, numeric));
}

function getLocalStorage(): Storage | null {
  if (typeof globalThis === 'undefined' || ('localStorage' in globalThis) === false) {
    return null;
  }

  return globalThis.localStorage ?? null;
}

export function hasStoredPaneSplit(storageKey: string): boolean {
  try {
    const raw = getLocalStorage()?.getItem(storageKey);
    if (raw === null || raw === undefined) {
      return false;
    }
    return Number.isFinite(Number(raw));
  } catch {
    return false;
  }
}

export function readStoredPaneSplitPercent(
  storageKey: string,
  fallback = DEFAULT_PANE_SPLIT_PERCENT,
): number {
  try {
    const raw = getLocalStorage()?.getItem(storageKey);
    return normalizePaneSplitPercent(raw, fallback);
  } catch {
    return fallback;
  }
}

export function saveStoredPaneSplitPercent(
  storageKey: string,
  splitPercent: number,
  fallback = DEFAULT_PANE_SPLIT_PERCENT,
): number {
  const normalized = normalizePaneSplitPercent(splitPercent, fallback);

  try {
    getLocalStorage()?.setItem(storageKey, String(normalized));
  } catch {
    // Ignore storage write failures and keep the in-memory split.
  }

  return normalized;
}

export function clearStoredPaneSplitPercent(storageKey: string): void {
  try {
    getLocalStorage()?.removeItem(storageKey);
  } catch {
    // Ignore storage failures; the in-memory state is reset by the caller anyway.
  }
}

export function shouldPersistPaneSplit(params: {
  wasDraggingSplit: boolean;
  isDraggingSplit: boolean;
}): boolean {
  return params.wasDraggingSplit && params.isDraggingSplit === false;
}

export function shouldStartPaneSplitPointerDrag(params: {
  hasActivePointer: boolean;
  isPrimary: boolean;
  pointerType: string;
  button: number;
}): boolean {
  if (params.hasActivePointer || params.isPrimary === false) {
    return false;
  }

  if (params.pointerType === 'mouse' && params.button > 0) {
    return false;
  }

  return true;
}

export function isActivePaneSplitPointer(
  activePointerId: number | null,
  pointerId: number,
): boolean {
  return activePointerId === pointerId;
}

export function clampPaneSplitPercent(params: {
  splitPercent: number;
  containerHeight: number;
  minPaneHeightPx?: number;
  dividerHeightPx?: number;
}): number {
  const {
    splitPercent,
    containerHeight,
    minPaneHeightPx = PANE_SPLIT_MIN_PANE_HEIGHT_PX,
    dividerHeightPx = PANE_SPLIT_DIVIDER_HEIGHT_PX,
  } = params;
  const normalizedSplitPercent = normalizePaneSplitPercent(splitPercent);

  if (Number.isFinite(containerHeight) === false || containerHeight <= 0) {
    return normalizedSplitPercent;
  }

  const usableHeight = Math.max(containerHeight - dividerHeightPx, 0);
  if (usableHeight <= 0) {
    return normalizedSplitPercent;
  }

  if (usableHeight <= minPaneHeightPx * 2) {
    return DEFAULT_PANE_SPLIT_PERCENT;
  }

  const minPercent = (minPaneHeightPx / usableHeight) * 100;
  return Math.min(100 - minPercent, Math.max(minPercent, normalizedSplitPercent));
}

export function getPaneSplitHeights(params: {
  splitPercent: number;
  containerHeight: number;
  minPaneHeightPx?: number;
  dividerHeightPx?: number;
}): {
  splitPercent: number;
  leadingPaneHeightPx: number;
  trailingPaneHeightPx: number;
} {
  const {
    containerHeight,
    minPaneHeightPx = PANE_SPLIT_MIN_PANE_HEIGHT_PX,
    dividerHeightPx = PANE_SPLIT_DIVIDER_HEIGHT_PX,
  } = params;

  if (Number.isFinite(containerHeight) === false || containerHeight <= 0) {
    return {
      splitPercent: normalizePaneSplitPercent(params.splitPercent),
      leadingPaneHeightPx: 0,
      trailingPaneHeightPx: 0,
    };
  }

  const usableHeight = Math.max(containerHeight - dividerHeightPx, 0);
  const splitPercent = clampPaneSplitPercent({
    splitPercent: params.splitPercent,
    containerHeight,
    minPaneHeightPx,
    dividerHeightPx,
  });
  const leadingPaneHeightPx = Math.round((usableHeight * splitPercent) / 100);

  return {
    splitPercent,
    leadingPaneHeightPx,
    trailingPaneHeightPx: Math.max(usableHeight - leadingPaneHeightPx, 0),
  };
}
