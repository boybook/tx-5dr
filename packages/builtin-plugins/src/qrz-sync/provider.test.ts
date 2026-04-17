import { describe, expect, it, vi } from 'vitest';

import type { QSORecord } from '@tx5dr/contracts';
import { QRZSyncProvider } from './provider.js';

function createQso(id: string, overrides: Partial<QSORecord> = {}): QSORecord {
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
    ...overrides,
  };
}

function createContext(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  const store = new Map<string, unknown>();
  const queryQSOs = vi.fn(async (_filter?: unknown) => [] as QSORecord[]);
  const updateQSO = vi.fn(async () => undefined);
  const notifyUpdated = vi.fn(async () => undefined);

  return {
    ctx: {
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
          updateQSO,
          notifyUpdated,
        })),
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      fetch: vi.fn(fetchImpl),
    } as any,
    queryQSOs,
    updateQSO,
    notifyUpdated,
  };
}

function okResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

describe('QRZSyncProvider', () => {
  it('auto-upload uses explicit records and skips already-uploaded QSOs', async () => {
    const { ctx, queryQSOs, updateQSO, notifyUpdated } = createContext(async () =>
      okResponse('RESULT=OK'),
    );
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      apiKey: 'api-key',
      autoUploadQSO: true,
    });

    const unsentQso = createQso('qso-1');
    const sentQso = createQso('qso-2', { qrzQslSent: 'Y' });
    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [unsentQso, sentQso],
    });

    expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 0, errors: undefined });
    expect(queryQSOs).not.toHaveBeenCalled();
    expect(updateQSO).toHaveBeenCalledTimes(1);
    expect(updateQSO).toHaveBeenCalledWith('qso-1', {
      qrzQslSent: 'Y',
      qrzQslSentDate: expect.any(Number),
    });
    expect(notifyUpdated).toHaveBeenCalledTimes(1);
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toEqual(expect.any(Number));
  });

  it('manual upload still scans the logbook for pending QSOs', async () => {
    const { ctx, queryQSOs } = createContext(async () => okResponse('RESULT=OK'));
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      apiKey: 'api-key',
      autoUploadQSO: true,
      lastSyncTime: 123456789,
    });

    queryQSOs.mockResolvedValue([
      createQso('qso-1'),
      createQso('qso-2', { qrzQslSent: 'Y' }),
    ]);

    const result = await provider.upload('BG5DRB');

    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(queryQSOs).toHaveBeenCalledTimes(1);
    expect(queryQSOs).toHaveBeenCalledWith({});
  });
});
