import { describe, expect, it, vi } from 'vitest';
import { FT8MessageType } from '@tx5dr/plugin-api';
import { createMockContext, createMockParsedMessage, createMockSlotInfo } from '@tx5dr/plugin-api/testing';
import { watchedCallsignAutocallPlugin, watchedCallsignAutocallTestables } from './index.js';

describe('watched-callsign-autocall', () => {
  it('reports auto-call enabled only when watch list has active entries', () => {
    expect(watchedCallsignAutocallTestables.isWatchedCallsignAutoCallEnabled(createMockContext({
      config: { watchList: ['JA1AAA'] },
    }))).toBe(true);
    expect(watchedCallsignAutocallTestables.isWatchedCallsignAutoCallEnabled(createMockContext({
      config: { watchList: ['  ', '# JA1AAA'] },
    }))).toBe(false);
  });

  it.each([
    'LOGBOOK_LOADING',
    'LOGBOOK_UNAVAILABLE',
  ])('defers the current slot when history is %s', async (code) => {
    const countQSOs = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
    const ctx = createMockContext({
      config: {
        watchList: ['JA1AAA'],
        watchMatchMode: 'exact',
        triggerMode: 'cq',
        workedCallsignSkipDays: 30,
      },
      logbook: { countQSOs },
    });
    const message = createMockParsedMessage({
      message: { type: FT8MessageType.CQ, senderCallsign: 'JA1AAA', grid: 'PM95' },
    });

    await expect(watchedCallsignAutocallPlugin.hooks?.onAutoCallCandidate?.(
      createMockSlotInfo(),
      [message],
      ctx,
    )).resolves.toBeNull();
    expect(countQSOs).toHaveBeenCalledOnce();
  });

  it('does not hide unexpected logbook query failures', async () => {
    const error = new Error('query invariant failed');
    const ctx = createMockContext({
      config: {
        watchList: ['JA1AAA'],
        watchMatchMode: 'exact',
        triggerMode: 'cq',
        workedCallsignSkipDays: 30,
      },
      logbook: { countQSOs: vi.fn().mockRejectedValue(error) },
    });
    const message = createMockParsedMessage({
      message: { type: FT8MessageType.CQ, senderCallsign: 'JA1AAA', grid: 'PM95' },
    });

    await expect(watchedCallsignAutocallPlugin.hooks?.onAutoCallCandidate?.(
      createMockSlotInfo(),
      [message],
      ctx,
    )).rejects.toBe(error);
  });
});
