import { describe, expect, it, vi } from 'vitest';

import type { PluginContext } from '@tx5dr/plugin-api';
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
    ctx: ctx as unknown as PluginContext,
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
  it('single auto-upload uses explicit records without querying the whole logbook', async () => {
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

    expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 0, failures: undefined });
    expect(queryQSOs).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toEqual(expect.any(Number));
  });

  it('auto-upload sends multiple explicit records as one WaveLog batch', async () => {
    const { ctx, queryQSOs, fetch } = createContext(async () =>
      okResponse({ status: 'created', adif_count: 2, adif_errors: 0 }, 201),
    );
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
    const requestBody = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { string: string };

    expect(result).toEqual({ uploaded: 2, skipped: 0, failed: 0, failures: undefined });
    expect(queryQSOs).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestBody.string.match(/<eor>/gi)).toHaveLength(2);
    expect(requestBody.string).toContain('\n');
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toEqual(expect.any(Number));
  });

  it('falls back to single uploads for WaveLog batch aborts and keeps cursor on failure', async () => {
    const responses = [
      okResponse({ status: 'abort', adif_count: 3, adif_errors: 1, messages: ['Duplicate in batch'] }, 400),
      okResponse({ status: 'created' }, 201),
      okResponse({ status: 'abort', messages: ['Duplicate for BG5DRB'] }, 400),
      okResponse({ status: 'error', message: 'Server rejected QSO' }, 500),
    ];
    const { ctx, fetch } = createContext(async () => responses.shift() ?? okResponse({ status: 'created' }));
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
      records: [createQso('qso-1'), createQso('qso-2'), createQso('qso-3')],
    });

    expect(result.uploaded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'wavelog_upload_rejected',
        message: 'Server rejected QSO',
        qsoCallsign: 'N0CALL',
        qsoId: 'qso-3',
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toBeUndefined();
  });

  it('manual upload keeps using the cursor-based logbook scan', async () => {
    const qso1 = createQso('qso-1');
    const qso2 = createQso('qso-2');
    const { ctx, queryQSOs, fetch } = createContext(async () =>
      okResponse({ status: 'created', adif_count: 2, adif_errors: 0 }, 201),
    );
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
    expect(fetch).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { string: string };
    expect(requestBody.string.match(/<eor>/gi)).toHaveLength(2);
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toEqual(expect.any(Number));
  });

  it('single upload still sends one single-record request', async () => {
    const { ctx, fetch } = createContext(async () => okResponse({ status: 'created' }, 201));
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
      records: [createQso('qso-1')],
    });
    const requestBody = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { string: string };

    expect(result.uploaded).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestBody.string.match(/<eor>/gi)).toHaveLength(1);
  });

  it('returns structured failure when WaveLog is not configured', async () => {
    const { ctx } = createContext(async () => okResponse({ status: 'created' }));
    const provider = new WaveLogSyncProvider(ctx);

    const result = await provider.upload('BG5DRB');

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'wavelog_not_configured',
        message: 'WaveLog not configured',
        providerId: 'wavelog',
      }),
    ]);
  });

  it('surfaces WaveLog HTTP JSON failure details', async () => {
    const { ctx } = createContext(async () =>
      okResponse({ status: 'error', message: 'Station profile is invalid' }, 500),
    );
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
      records: [createQso('qso-1')],
    });

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'wavelog_upload_rejected',
        message: 'Station profile is invalid',
        qsoCallsign: 'N0CALL',
      }),
    ]);
  });

  it('surfaces WaveLog invalid JSON response details', async () => {
    const { ctx } = createContext(async () =>
      new Response('upstream exploded', { status: 502 }),
    );
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
      records: [createQso('qso-1')],
    });

    expect(result.failures?.[0]).toEqual(expect.objectContaining({
      code: 'wavelog_upload_failed',
      message: expect.stringContaining('upstream exploded'),
    }));
  });

  it.each([401, 403, 404])('does not fallback single-upload on batch HTTP %s', async (status) => {
    const { ctx, fetch } = createContext(async () =>
      okResponse({ status: 'failed', reason: 'request rejected' }, status),
    );
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

    expect(result.uploaded).toBe(0);
    expect(result.failed).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.failures).toHaveLength(2);
    expect(result.failures?.[0]).toEqual(expect.objectContaining({
      message: 'request rejected',
    }));
  });

  it('does not fallback single-upload on batch network failure', async () => {
    const { ctx, fetch } = createContext(async () => {
      throw new Error('fetch failed');
    });
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

    expect(result.uploaded).toBe(0);
    expect(result.failed).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.failures?.[0]).toEqual(expect.objectContaining({
      code: 'wavelog_upload_failed',
      message: 'Network request failed: check URL, network, and firewall',
    }));
  });
});
