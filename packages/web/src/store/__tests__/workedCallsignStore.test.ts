import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QSORecord } from '@tx5dr/contracts';

const mocks = vi.hoisted(() => ({ getLogBookQSOs: vi.fn() }));
vi.mock('@tx5dr/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tx5dr/core')>()),
  api: { getLogBookQSOs: mocks.getLogBookQSOs },
}));

import { workedCallsignStore } from '../workedCallsignStore';

const qso = (callsign: string, frequency: number, mode: string, id = callsign + frequency): QSORecord => ({
  id, callsign, frequency, mode, startTime: 0, endTime: 0, messageHistory: [],
} as unknown as QSORecord);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  workedCallsignStore.setContext(null);
  mocks.getLogBookQSOs.mockReset();
});

describe('workedCallsignStore', () => {
  it('classifies exact callsign matches by band and mode and follows new QSOs', async () => {
    mocks.getLogBookQSOs.mockImplementation(async (_id: string, options: { callsign: string }) => ({
      success: true,
      data: options.callsign === 'JA1XYZ'
        ? [qso('JA1XYZ', 14_080_000, 'RTTY'), qso('JA1XYZ/P', 7_040_000, 'RTTY')]
        : options.callsign === 'K1ABC' ? [qso('K1ABC', 7_040_000, 'RTTY')] : [],
    }));
    workedCallsignStore.setContext({ logbookId: 'BG5DRB', band: '20m', mode: 'RTTY' });
    for (const call of ['JA1XYZ', 'K1ABC', 'W1AW']) workedCallsignStore.request(call);
    await flush(); await flush();
    expect(workedCallsignStore.get('JA1XYZ')).toBe('dupe');
    expect(workedCallsignStore.get('K1ABC')).toBe('worked');
    expect(workedCallsignStore.get('W1AW')).toBe('new');

    // Changing band reclassifies cached lookups without fetching again.
    workedCallsignStore.setContext({ logbookId: 'BG5DRB', band: '40m', mode: 'RTTY' });
    expect(workedCallsignStore.get('K1ABC')).toBe('dupe');
    expect(mocks.getLogBookQSOs).toHaveBeenCalledTimes(3);

    workedCallsignStore.noteQso('BG5DRB', qso('W1AW', 7_041_000, 'RTTY'));
    expect(workedCallsignStore.get('W1AW')).toBe('dupe');
    workedCallsignStore.noteQso('OTHER', qso('JA1XYZ', 1, 'CW'));
  });

  it('looks up callsigns requested before the logbook was known', async () => {
    mocks.getLogBookQSOs.mockResolvedValue({ success: true, data: [qso('JA1EARLY', 14_080_000, 'RTTY')] });
    workedCallsignStore.request('JA1EARLY');
    expect(mocks.getLogBookQSOs).not.toHaveBeenCalled();
    workedCallsignStore.setContext({ logbookId: 'BG5DRB', band: '20m', mode: 'RTTY' });
    await flush(); await flush();
    expect(workedCallsignStore.get('JA1EARLY')).toBe('dupe');
  });
});
