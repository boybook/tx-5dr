import { describe, expect, it, vi } from 'vitest';

import type { QSORecord } from '@tx5dr/contracts';
import { WaveLogSyncProvider } from './provider.js';

function createQso(id: string): QSORecord {
  return {
    id,
    callsign: 'N0CALL',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-04-17T12:00:00.000Z'),
    endTime: Date.parse('2026-04-17T12:01:00.000Z'),
    messageHistory: [],
    myCallsign: 'BG5DRB',
    myGrid: 'PM01AA',
  };
}

function createContext(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  const store = new Map<string, unknown>();
  const queryQSOs = vi.fn(async (_filter?: unknown) => [] as QSORecord[]);
  const ctx = {
    store: {
      global: {
        get: vi.fn((key: string) => store.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          store.set(key, value);
        }),
      },
    },
    logbook: {
      forCallsign: vi.fn(() => ({
        queryQSOs,
      })),
    },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    fetch: vi.fn(fetchImpl),
  };

  return {
    ctx: ctx as any,
    store,
    queryQSOs,
    fetch: ctx.fetch,
  };
}

function okResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WaveLogSyncProvider', () => {
  it('auto-upload uses explicit records without querying the whole logbook', async () => {
    const { ctx, queryQSOs, fetch } = createContext(async () => okResponse({ status: 'created' }));
    const provider = new WaveLogSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      url: 'https://wavelog.example.com',
      apiKey: 'api-key',
      stationId: 'station-1',
      radioName: 'TX5DR',
      autoUploadQSO: true,
    });

    const qso = createQso('qso-1');
    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [qso],
    });

    expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 0, errors: undefined });
    expect(queryQSOs).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toEqual(expect.any(Number));
  });

  it('does not advance lastSyncTime when an auto-upload batch has failures', async () => {
    const responses = [
      okResponse({ status: 'created' }),
      okResponse({ status: 'error', message: 'Server rejected QSO' }, 500),
    ];
    const { ctx } = createContext(async () => responses.shift() ?? okResponse({ status: 'created' }));
    const provider = new WaveLogSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      url: 'https://wavelog.example.com',
      apiKey: 'api-key',
      stationId: 'station-1',
      radioName: 'TX5DR',
      autoUploadQSO: true,
    });

    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [createQso('qso-1'), createQso('qso-2')],
    });

    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual(['N0CALL: Server rejected QSO']);
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toBeUndefined();
  });

  it('manual upload keeps using the cursor-based logbook scan', async () => {
    const qso1 = createQso('qso-1');
    const qso2 = createQso('qso-2');
    const { ctx, queryQSOs, fetch } = createContext(async () => okResponse({ status: 'created' }));
    queryQSOs.mockResolvedValue([qso1, qso2]);

    const provider = new WaveLogSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      url: 'https://wavelog.example.com',
      apiKey: 'api-key',
      stationId: 'station-1',
      radioName: 'TX5DR',
      autoUploadQSO: true,
      lastSyncTime: 123456789,
    });

    const result = await provider.upload('BG5DRB');
    const queryArg = queryQSOs.mock.calls[0]?.[0] as { timeRange?: { start: number; end: number } } | undefined;

    expect(result.uploaded).toBe(2);
    expect(result.failed).toBe(0);
    expect(queryQSOs).toHaveBeenCalledTimes(1);
    expect(queryArg).toMatchObject({
      timeRange: {
        start: 123456789,
      },
    });
    expect(queryArg?.timeRange?.end).toEqual(expect.any(Number));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toEqual(expect.any(Number));
  });
});
