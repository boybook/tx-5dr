import { describe, expect, it } from 'vitest';
import {
  MAX_RENDERER_FILE_SAVE_BYTES,
  copyRendererFileBytes,
  sanitizeRendererSaveFileName,
} from '../rendererFileSave.js';

describe('renderer file save boundary', () => {
  it('removes path separators and platform-invalid filename characters', () => {
    expect(sanitizeRendererSaveFileName('../fax:<capture>.png')).toBe('.._fax__capture_.png');
    expect(sanitizeRendererSaveFileName('   ')).toBe('download.bin');
  });

  it('copies typed bytes instead of retaining renderer-owned memory', () => {
    const source = new Uint8Array([1, 2, 3]);
    const result = copyRendererFileBytes(source);
    source[0] = 9;
    expect([...result]).toEqual([1, 2, 3]);
  });

  it('rejects unsupported payloads and exposes the bounded transfer limit', () => {
    expect(() => copyRendererFileBytes('not bytes')).toThrow('INVALID_RENDERER_FILE_DATA');
    expect(MAX_RENDERER_FILE_SAVE_BYTES).toBe(256 * 1024 * 1024);
  });
});
