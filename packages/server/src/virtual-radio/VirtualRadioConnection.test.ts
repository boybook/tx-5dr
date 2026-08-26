import { describe, expect, it, vi } from 'vitest';
import { VirtualRadioConnection } from './VirtualRadioConnection.js';

describe('VirtualRadioConnection', () => {
  it('keeps frequency, mode, and PTT entirely in memory', async () => {
    const connection = new VirtualRadioConnection(14_090_000);
    const frequencyChanged = vi.fn();
    connection.on('frequencyChanged', frequencyChanged);
    await connection.connect({ type: 'none' });
    await connection.setFrequency(7_090_000);
    await connection.setMode('USB');
    await connection.setPTT(true);
    expect(await connection.getFrequency()).toBe(7_090_000);
    expect(await connection.getMode()).toMatchObject({ mode: 'USB' });
    expect(connection.isPTTEnabled()).toBe(true);
    expect(frequencyChanged).toHaveBeenCalledWith(7_090_000);
    await connection.disconnect('done');
    expect(connection.isPTTEnabled()).toBe(false);
  });
});
