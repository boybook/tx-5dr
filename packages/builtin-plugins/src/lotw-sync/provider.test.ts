import { describe, expect, it, vi } from 'vitest';

import type { QSORecord } from '@tx5dr/contracts';
import { LoTWSyncProvider } from './provider.js';

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

function createContext() {
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
      files: {
        read: vi.fn(async () => null),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      fetch: vi.fn(),
    } as any,
    queryQSOs,
    updateQSO,
    notifyUpdated,
  };
}

describe('LoTWSyncProvider', () => {
  it('auto-upload uses explicit records without rescanning the logbook', async () => {
    const { ctx, queryQSOs, updateQSO, notifyUpdated } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      username: 'user',
      password: 'pass',
      uploadLocation: {
        callsign: 'BG5DRB',
        dxccId: 291,
        gridSquare: 'PM01AA',
        cqZone: '24',
        ituZone: '44',
      },
      autoUploadQSO: true,
    });

    const qso = createQso('qso-1');
    const prepareUpload = vi.spyOn(provider as any, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [
        {
          qsos: [qso],
          certificate: { callsign: 'BG5DRB' },
        },
      ],
    });
    vi.spyOn(provider as any, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB' });
    const uploadBatch = vi.spyOn(provider as any, 'uploadBatch').mockResolvedValue(undefined);

    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [qso, createQso('qso-2', { lotwQslSent: 'Y' })],
    });

    expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 0, errors: undefined });
    expect(queryQSOs).not.toHaveBeenCalled();
    expect(prepareUpload).toHaveBeenCalledWith(expect.anything(), [qso], 'BG5DRB');
    expect(uploadBatch).toHaveBeenCalledTimes(1);
    expect(updateQSO).toHaveBeenCalledWith('qso-1', {
      lotwQslSent: 'Y',
      lotwQslSentDate: expect.any(Number),
    });
    expect(notifyUpdated).toHaveBeenCalledTimes(1);
    expect(provider.getConfig('BG5DRB')?.lastUploadTime).toEqual(expect.any(Number));
  });

  it('manual upload still scans the logbook for unsent QSOs', async () => {
    const { ctx, queryQSOs } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      username: 'user',
      password: 'pass',
      uploadLocation: {
        callsign: 'BG5DRB',
        dxccId: 291,
        gridSquare: 'PM01AA',
        cqZone: '24',
        ituZone: '44',
      },
      autoUploadQSO: true,
    });

    const qso = createQso('qso-1');
    queryQSOs.mockResolvedValue([qso]);
    const prepareUpload = vi.spyOn(provider as any, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [
        {
          qsos: [qso],
          certificate: { callsign: 'BG5DRB' },
        },
      ],
    });
    vi.spyOn(provider as any, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB' });
    vi.spyOn(provider as any, 'uploadBatch').mockResolvedValue(undefined);

    const result = await provider.upload('BG5DRB');

    expect(result.uploaded).toBe(1);
    expect(queryQSOs).toHaveBeenCalledTimes(1);
    expect(queryQSOs).toHaveBeenCalledWith({});
    expect(prepareUpload).toHaveBeenCalledWith(expect.anything(), [qso], 'BG5DRB');
  });
});
