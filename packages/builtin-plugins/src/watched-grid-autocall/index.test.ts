import { describe, expect, it } from 'vitest';
import { FT8MessageType } from '@tx5dr/plugin-api';
import { createMockContext, createMockParsedMessage, createMockSlotInfo } from '@tx5dr/plugin-api/testing';
import { watchedGridAutocallPlugin, watchedGridAutocallTestables } from './index.js';

describe('watched-grid-autocall', () => {
  it('proposes an autocall when a watched grid appears', async () => {
    const ctx = createMockContext({
      config: {
        gridWatchList: ['PM95'],
        gridMatchMode: 'exact',
        triggerMode: 'cq',
        workedGridSkipEnabled: false,
      },
      operator: { automation: { currentState: 'TX6', slots: {}, context: {} } as any },
    });
    const message = createMockParsedMessage({
      message: { type: FT8MessageType.CQ, senderCallsign: 'JA1AAA', grid: 'PM95AB' },
      rawMessage: 'CQ JA1AAA PM95',
    });

    const proposal = await watchedGridAutocallPlugin.hooks?.onAutoCallCandidate?.(createMockSlotInfo(), [message], ctx);
    expect(proposal?.callsign).toBe('JA1AAA');
  });

  it('ignores messages without a grid', async () => {
    const ctx = createMockContext({
      config: { gridWatchList: ['PM95'], gridMatchMode: 'exact', triggerMode: 'cq' },
      operator: { automation: { currentState: 'TX6', slots: {}, context: {} } as any },
    });
    const message = createMockParsedMessage({
      message: { type: FT8MessageType.CQ, senderCallsign: 'JA1AAA' },
      rawMessage: 'CQ JA1AAA',
    });

    const proposal = await watchedGridAutocallPlugin.hooks?.onAutoCallCandidate?.(createMockSlotInfo(), [message], ctx);
    expect(proposal).toBeNull();
  });

  it('skips already worked grids when enabled', async () => {
    const ctx = createMockContext({
      config: {
        gridWatchList: ['PM95'],
        gridMatchMode: 'exact',
        triggerMode: 'cq',
        workedGridSkipEnabled: true,
      },
      operator: { automation: { currentState: 'TX6', slots: {}, context: {} } as any },
      logbook: { hasWorkedGrid: async () => true },
    });
    const message = createMockParsedMessage({
      message: { type: FT8MessageType.CQ, senderCallsign: 'JA1AAA', grid: 'PM95' },
    });

    const proposal = await watchedGridAutocallPlugin.hooks?.onAutoCallCandidate?.(createMockSlotInfo(), [message], ctx);
    expect(proposal).toBeNull();
  });

  it('does not interrupt a non-idle operator', async () => {
    const ctx = createMockContext({
      config: { gridWatchList: ['PM95'], gridMatchMode: 'exact', triggerMode: 'cq' },
      operator: { isTransmitting: true },
    });
    const message = createMockParsedMessage({
      message: { type: FT8MessageType.CQ, senderCallsign: 'JA1AAA', grid: 'PM95' },
    });

    const proposal = await watchedGridAutocallPlugin.hooks?.onAutoCallCandidate?.(createMockSlotInfo(), [message], ctx);
    expect(proposal).toBeNull();
  });

  it('reports auto-call enabled only when grid watch list has active entries', () => {
    expect(watchedGridAutocallTestables.isWatchedGridAutoCallEnabled(createMockContext({
      config: { gridWatchList: ['PM95'] },
    }))).toBe(true);
    expect(watchedGridAutocallTestables.isWatchedGridAutoCallEnabled(createMockContext({
      config: { gridWatchList: ['  ', '# PM95'] },
    }))).toBe(false);
  });
});
