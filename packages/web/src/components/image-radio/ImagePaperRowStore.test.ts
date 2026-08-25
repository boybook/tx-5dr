import { describe, expect, it } from 'vitest';

import { decodeImageRowBase64, ImagePaperRowStore, writePaperRowsToRgba } from './ImagePaperRowStore';

describe('ImagePaperRowStore', () => {
  it('indexes rows by bounded buckets and only changes affected range revisions', () => {
    const store = new ImagePaperRowStore();
    store.set(10, { width: 1, pixels: new Uint8Array([1]), rowRevision: 0 });
    const firstRevision = store.rangeRevision(0, 256);
    expect(firstRevision).toBeGreaterThan(0);
    expect(store.rangeRevision(256, 512)).toBe(0);

    store.set(300, { width: 1, pixels: new Uint8Array([2]), rowRevision: 0 });
    expect(store.rangeRevision(0, 256)).toBe(firstRevision);
    expect(store.rangeRevision(256, 512)).toBeGreaterThan(firstRevision);

    const offsetChunkRevision = store.rangeRevision(100, 356);
    store.set(356, { width: 1, pixels: new Uint8Array([3]), rowRevision: 0 });
    expect(store.rangeRevision(100, 356)).toBe(offsetChunkRevision);
  });

  it('ignores stale line revisions and removes truncated rows', () => {
    const store = new ImagePaperRowStore();
    expect(store.set(255, { width: 1, pixels: new Uint8Array([9]), rowRevision: 2 })).toBe(true);
    expect(store.set(255, { width: 1, pixels: new Uint8Array([3]), rowRevision: 1 })).toBe(false);
    store.set(256, { width: 1, pixels: new Uint8Array([8]), rowRevision: 0 });
    store.deleteBefore(256);

    const rows: number[] = [];
    store.forEachInRange(0, 512, (line) => rows.push(line));
    expect(rows).toEqual([256]);
  });

  it('writes a whole grayscale range into one reusable RGBA buffer', () => {
    const store = new ImagePaperRowStore();
    store.set(4, { width: 2, pixels: new Uint8Array([10, 20]), rowRevision: 0 });
    store.set(5, { width: 1, pixels: new Uint8Array([30]), rowRevision: 0 });
    const rgba = new Uint8ClampedArray(2 * 2 * 4);

    writePaperRowsToRgba(rgba, 2, 4, 6, 'gray8', store);
    expect([...rgba]).toEqual([
      10, 10, 10, 255, 20, 20, 20, 255,
      30, 30, 30, 255, 30, 30, 30, 255,
    ]);
  });

  it('writes packed RGB and decodes base64 without an allocation callback', () => {
    const store = new ImagePaperRowStore();
    store.set(0, { width: 1, pixels: new Uint8Array([1, 2, 3]), rowRevision: 0 });
    const rgba = new Uint8ClampedArray(4);
    writePaperRowsToRgba(rgba, 1, 0, 1, 'rgb8', store);
    expect([...rgba]).toEqual([1, 2, 3, 255]);
    expect([...decodeImageRowBase64('AQID')]).toEqual([1, 2, 3]);
  });

  it('applies FAX phase correction across nominal paper rows', () => {
    const store = new ImagePaperRowStore();
    store.set(0, { width: 4, pixels: new Uint8Array([0, 1, 2, 3]), rowRevision: 0 });
    store.set(1, { width: 4, pixels: new Uint8Array([4, 5, 6, 7]), rowRevision: 0 });
    const rgba = new Uint8ClampedArray(8 * 4);
    writePaperRowsToRgba(rgba, 4, 0, 2, 'gray8', store, {
      boundaryId: 'fax', revision: 1, autoEnabled: true,
      autoPoints: [{ revision: 1, referenceLine: 0, phasePixels: 1, clockPpm: 0, confidence: 1, source: 'manual', status: 'locked' }],
      manualPhasePixels: 0, manualClockPpm: 0, updatedAt: 1,
    }, 0);
    expect([rgba[0], rgba[4], rgba[8], rgba[12], rgba[16], rgba[20], rgba[24], rgba[28]])
      .toEqual([255, 0, 1, 2, 3, 4, 5, 6]);
  });
});
