export const DEFAULT_RIGHT_LAYOUT_SPLIT_PERCENT = 50;
export const RIGHT_LAYOUT_SPLIT_DIVIDER_HEIGHT_PX = 8;
export const RIGHT_LAYOUT_MIN_PANE_HEIGHT_PX = 180;

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
