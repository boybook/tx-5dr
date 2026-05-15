import { describe, expect, it } from 'vitest';
import {
  createWaterfallUploadBuffer,
  ensureWaterfallScratchRow,
  getWaterfallCanvasPixelRatio,
  releaseWaterfallTextureMemoryRefs,
} from './WebGLWaterfall';

describe('WebGLWaterfall texture memory release', () => {
  it('drops the CPU scratch row and resets texture metadata', () => {
    const scratchRowRef = { current: new Uint8Array(1024) as Uint8Array | null };
    const lastDataLengthRef = { current: 1024 * 512 };
    const textureHeightRef = { current: 512 };
    const rowCountRef = { current: 120 };
    const headRowRef = { current: 42 };

    releaseWaterfallTextureMemoryRefs({
      scratchRowRef,
      lastDataLengthRef,
      textureHeightRef,
      rowCountRef,
      headRowRef,
    });

    expect(scratchRowRef.current).toBeNull();
    expect(lastDataLengthRef.current).toBe(0);
    expect(textureHeightRef.current).toBe(1);
    expect(rowCountRef.current).toBe(0);
    expect(headRowRef.current).toBe(0);
  });

  it('uses bounded canvas pixel ratio for high-DPI waterfall rendering', () => {
    expect(getWaterfallCanvasPixelRatio(undefined)).toBe(1);
    expect(getWaterfallCanvasPixelRatio(0.75)).toBe(1);
    expect(getWaterfallCanvasPixelRatio(1.25)).toBe(1.25);
    expect(getWaterfallCanvasPixelRatio(3)).toBe(1.5);
  });

  it('allocates transient full upload buffers and reusable scratch rows separately', () => {
    const fullUpload = createWaterfallUploadBuffer(1024, 120);
    const scratch = ensureWaterfallScratchRow(null, 1024);

    expect(fullUpload).toHaveLength(1024 * 120);
    expect(scratch).toHaveLength(1024);
    expect(ensureWaterfallScratchRow(scratch, 1024)).toBe(scratch);
    expect(ensureWaterfallScratchRow(scratch, 512)).toHaveLength(512);
  });
});
