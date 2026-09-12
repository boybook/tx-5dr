import { describe, expect, it } from 'vitest';
import { getFrameGroupRenderRange } from './frameVirtualRange';
import type { FrameDisplayMessage } from './FramesTable';

const groups = (sizes: number[]) => sizes.map(size => ({ messages: Array.from({ length: size }, () => ({} as FrameDisplayMessage)) }));

describe('frame group overscan', () => {
  it('keeps all visible groups and only adjacent dense groups', () => {
    expect(getFrameGroupRenderRange({ startIndex: 4, endIndex: 5, count: 10, overscan: 5 }, groups(Array(10).fill(40))))
      .toEqual([3, 4, 5, 6]);
  });
  it('preserves the existing group budget for sparse histories', () => {
    expect(getFrameGroupRenderRange({ startIndex: 6, endIndex: 7, count: 15, overscan: 5 }, groups(Array(15).fill(1))))
      .toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });
  it('handles mixed density independently on either side of the viewport', () => {
    expect(getFrameGroupRenderRange({ startIndex: 4, endIndex: 4, count: 9, overscan: 5 }, groups([1, 1, 40, 1, 1, 40, 1, 1, 1])))
      .toEqual([2, 3, 4, 5]);
  });
  it('stays within history bounds and honors zero overscan', () => {
    const history = groups([50, 50, 50]);
    expect(getFrameGroupRenderRange({ startIndex: 0, endIndex: 0, count: 3, overscan: 5 }, history)).toEqual([0, 1]);
    expect(getFrameGroupRenderRange({ startIndex: 2, endIndex: 2, count: 3, overscan: 5 }, history)).toEqual([1, 2]);
    expect(getFrameGroupRenderRange({ startIndex: 1, endIndex: 1, count: 3, overscan: 0 }, history)).toEqual([1]);
    expect(getFrameGroupRenderRange({ startIndex: 0, endIndex: 0, count: 0, overscan: 5 }, [])).toEqual([]);
  });
});
