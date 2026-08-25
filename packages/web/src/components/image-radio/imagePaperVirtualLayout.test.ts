import { describe, expect, it } from 'vitest';

import { buildPaperLayout, paperBottomTarget, visiblePaperItems } from './imagePaperVirtualLayout';

const boundary = {
  boundaryId: 'paper', lineIndex: 0, kind: 'initial' as const, trusted: false,
  codecMode: 'fax', width: 1_810, pixelFormat: 'gray8' as const, timestamp: 1,
};

describe('image paper virtual layout', () => {
  it('mounts only the viewport and overscan from a very long paper', () => {
    const chunks = Array.from({ length: 1_000 }, (_, index) => ({ startLine: index * 256, endLine: (index + 1) * 256 }));
    const layout = buildPaperLayout([{ boundary, displayWidth: 1_810, chunks, data: null }], 905, () => 0);
    const visible = visiblePaperItems(layout.items, 0, 50_000, 800);

    expect(layout.items).toHaveLength(1_000);
    expect(visible.length).toBeLessThan(24);
    expect(visible.every((item) => item.top + item.height >= 49_200 && item.top <= 51_600)).toBe(true);
  });

  it('uses exact scaled chunk heights without accumulating a bottom gap', () => {
    const layout = buildPaperLayout([{
      boundary, displayWidth: 800,
      chunks: [{ startLine: 0, endLine: 256 }, { startLine: 256, endLine: 512 }], data: null,
    }], 400, () => 18);

    expect(layout.height).toBe(274);
    expect(paperBottomTarget(layout.height, 200)).toBe(74);
  });

  it('preserves each SSTV segment aspect ratio when mode widths differ', () => {
    const robot36 = { ...boundary, boundaryId: 'robot36', codecMode: 'robot36', width: 320, pixelFormat: 'rgb8' as const };
    const pd120 = { ...boundary, boundaryId: 'pd120', lineIndex: 240, codecMode: 'pd120', width: 640, pixelFormat: 'rgb8' as const };
    const layout = buildPaperLayout([
      { boundary: robot36, displayWidth: robot36.width, chunks: [{ startLine: 0, endLine: 240 }], data: null },
      { boundary: pd120, displayWidth: pd120.width, chunks: [{ startLine: 240, endLine: 736 }], data: null },
    ], 640, () => 0);

    expect(layout.items[0]).toMatchObject({ height: 480 });
    expect(layout.items[1]).toMatchObject({ top: 480, height: 496 });
    expect(layout.height).toBe(976);
  });

  it('bottom-aligns short paper without negative scrolling', () => {
    expect(paperBottomTarget(120, 600)).toBe(0);
  });
});
