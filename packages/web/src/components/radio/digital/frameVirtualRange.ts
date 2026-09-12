import type { Range } from '@tanstack/react-virtual';
import type { FrameGroup } from './FramesTable';

const OVERSCAN_ROWS = 32;

/** Preserve whole groups while limiting overdraw around a dense decode window. */
export function getFrameGroupRenderRange(range: Range, groups: readonly Pick<FrameGroup, 'messages'>[]): number[] {
  if (range.count === 0) return [];
  let start = range.startIndex;
  let end = range.endIndex;
  let rows = 0;
  for (let extra = 0; start > 0 && extra < range.overscan && rows < OVERSCAN_ROWS; extra++) {
    start--;
    rows += Math.max(1, groups[start].messages.length);
  }
  rows = 0;
  for (let extra = 0; end < range.count - 1 && extra < range.overscan && rows < OVERSCAN_ROWS; extra++) {
    end++;
    rows += Math.max(1, groups[end].messages.length);
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
