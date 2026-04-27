import { describe, expect, it } from 'vitest';
import { releaseWaterfallTextureMemoryRefs } from './WebGLWaterfall';

describe('WebGLWaterfall texture memory release', () => {
  it('drops the large CPU texture buffer and resets texture metadata', () => {
    const textureDataRef = { current: new Uint8Array(1024 * 1024) as Uint8Array | null };
    const lastDataLengthRef = { current: textureDataRef.current.length };
    const textureHeightRef = { current: 512 };
    const rowCountRef = { current: 120 };
    const headRowRef = { current: 42 };

    releaseWaterfallTextureMemoryRefs({
      textureDataRef,
      lastDataLengthRef,
      textureHeightRef,
      rowCountRef,
      headRowRef,
    });

    expect(textureDataRef.current).toBeNull();
    expect(lastDataLengthRef.current).toBe(0);
    expect(textureHeightRef.current).toBe(1);
    expect(rowCountRef.current).toBe(0);
    expect(headRowRef.current).toBe(0);
  });
});
