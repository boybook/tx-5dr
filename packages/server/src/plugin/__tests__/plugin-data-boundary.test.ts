import { describe, expect, it } from 'vitest';
import { snapshotPluginData } from '../plugin-data-boundary.js';

describe('plugin data boundary', () => {
  it.each(['structured', 'json'] as const)('reads accessors once in %s mode', (mode) => {
    let reads = 0;
    const value = {
      get sample() {
        reads += 1;
        return reads;
      },
    };

    expect(snapshotPluginData(value, mode)).toEqual({ sample: 1 });
    expect(reads).toBe(1);
  });

  it('rejects shared memory returned through an accessor', () => {
    const shared = new SharedArrayBuffer(4);
    const value = {
      get shared() {
        return shared;
      },
    };

    expect(() => snapshotPluginData(value, 'structured')).toThrow(expect.objectContaining({
      code: 'PLUGIN_DATA_NOT_SERIALIZABLE',
      valueType: 'SharedArrayBuffer',
    }));
  });

  it('rejects typed arrays backed by shared memory', () => {
    const view = new Uint8Array(new SharedArrayBuffer(4));

    expect(() => snapshotPluginData(view, 'structured')).toThrow(expect.objectContaining({
      code: 'PLUGIN_DATA_NOT_SERIALIZABLE',
      valueType: 'Uint8Array',
    }));
  });
});
