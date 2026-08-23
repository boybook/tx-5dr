import { describe, expect, it, vi } from 'vitest';

import type { PluginContextFor } from '@tx5dr/plugin-api';
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
  const addQSO = vi.fn(async (record: QSORecord) => ({
    ...record,
    messageHistory: [...record.messageHistory],
  }));
  const updateQSO = vi.fn(async (id: string, updates: Partial<QSORecord>) => createQso(id, {
    ...updates,
    id,
    messageHistory: [...(updates.messageHistory ?? [])],
  }));
  const readQsoSnapshot = vi.fn(async () => ({ revision: 'revision-1', records: [] as QSORecord[] }));
  const applyQsoBatch = vi.fn(async (
    mutations: Array<
      | { type: 'add'; record: QSORecord }
      | { type: 'update'; qsoId: string; updates: Partial<QSORecord> }
    >,
  ) => ({
    revision: 'revision-2',
    outcomes: await Promise.all(mutations.map(async (mutation, inputIndex) => {
      if (mutation.type === 'add') {
        const record = await addQSO(mutation.record);
        return { inputIndex, status: 'added' as const, record };
      }
      const record = await updateQSO(mutation.qsoId, mutation.updates);
      return { inputIndex, status: 'updated' as const, record };
    })),
  }));
  const notifyUpdated = vi.fn(async () => undefined);

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
        addQSO,
        updateQSO,
        readQsoSnapshot,
        applyQsoBatch,
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
  };

  return {
    ctx: ctx as unknown as PluginContext,
    queryQSOs,
    addQSO,
    updateQSO,
    readQsoSnapshot,
    applyQsoBatch,
    notifyUpdated,
    fetch: ctx.fetch,
  };
}

function okResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function qrzDownloadResponse(records: Array<{
  logId: number;
  call: string;
  qsoDate: string;
  timeOn: string;
  freq?: string;
  mode?: string;
  stationCallsign?: string;
  status?: string;
  qslDate?: string;
}>): Response {
  const adif = records.map((record) => {
    const freq = record.freq ?? '14.074000';
    const mode = record.mode ?? 'FT8';
    const stationCallsign = record.stationCallsign ?? 'BG5DRB';
    const fields = [
      `<call:${record.call.length}>${record.call}`,
      `<qso_date:8>${record.qsoDate}`,
      `<time_on:6>${record.timeOn}`,
      `<freq:${freq.length}>${freq}`,
      `<mode:${mode.length}>${mode}`,
      `<station_callsign:${stationCallsign.length}>${stationCallsign}`,
      `<app_qrzlog_logid:${String(record.logId).length}>${record.logId}`,
    ];
    if (record.status) fields.push(`<app_qrzlog_status:${record.status.length}>${record.status}`);
    if (record.qslDate) fields.push(`<app_qrzlog_qsldate:${record.qslDate.length}>${record.qslDate}`);
    return `${fields.join('')}<eor>`;
  }).join('\n');
  return okResponse(`RESULT=OK&COUNT=${records.length}&ADIF=${adif}`);
}

describe('QRZSyncProvider', () => {
  it('auto-upload uses explicit records and skips already-uploaded QSOs', async () => {
    const { ctx, queryQSOs, updateQSO, readQsoSnapshot, notifyUpdated } = createContext(async () =>
      okResponse('RESULT=OK'),
    );
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      apiKey: 'api-key',
      autoUploadQSO: true,
    });

    const unsentQso = createQso('qso-1');
    const sentQso = createQso('qso-2', { qrzQslSent: 'Y' });
    readQsoSnapshot.mockResolvedValue({ revision: 'revision-1', records: [unsentQso, sentQso] });
    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [unsentQso, sentQso],
    });

    expect(result).toEqual({ submitted: 1, uploaded: 1, skipped: 0, failed: 0, failures: undefined });
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
    const { ctx, queryQSOs, readQsoSnapshot } = createContext(async () => okResponse('RESULT=OK'));
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      apiKey: 'api-key',
      autoUploadQSO: true,
      lastSyncTime: 123456789,
    });

    const unsent = createQso('qso-1');
    const sent = createQso('qso-2', { qrzQslSent: 'Y' });
    queryQSOs.mockResolvedValue([unsent, sent]);
    readQsoSnapshot.mockResolvedValue({ revision: 'revision-1', records: [unsent, sent] });

    const result = await provider.upload('BG5DRB');

    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(queryQSOs).toHaveBeenCalledTimes(1);
    expect(queryQSOs).toHaveBeenCalledWith({});
  });

  it('returns structured failure when QRZ is not configured', async () => {
    const { ctx } = createContext(async () => okResponse('RESULT=OK'));
    const provider = new QRZSyncProvider(ctx);

    const result = await provider.upload('BG5DRB');

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'qrz_not_configured',
        message: 'QRZ not configured',
        providerId: 'qrz',
      }),
    ]);
  });

  it('surfaces QRZ API rejection details as structured failures', async () => {
    const { ctx } = createContext(async () => okResponse('RESULT=FAIL&REASON=Invalid API key'));
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      apiKey: 'api-key',
      autoUploadQSO: true,
    });

    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [createQso('qso-1')],
    });

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'qrz_upload_rejected',
        message: 'Invalid API key',
        qsoCallsign: 'N0CALL',
      }),
    ]);
  });

  it('surfaces QRZ network errors as retryable structured failures', async () => {
    const { ctx } = createContext(async () => {
      throw new Error('fetch failed');
    });
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      apiKey: 'api-key',
      autoUploadQSO: true,
    });

    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [createQso('qso-1')],
    });

    expect(result.failures?.[0]).toEqual(expect.objectContaining({
      code: 'qrz_upload_failed',
      source: 'network',
      retryable: true,
    }));
  });

  it('batches local sent-state updates after individual remote INSERT requests', async () => {
    const { ctx, readQsoSnapshot, applyQsoBatch, notifyUpdated, fetch } = createContext(async () =>
      okResponse('RESULT=OK'),
    );
    const records = [createQso('qso-1'), createQso('qso-2')];
    readQsoSnapshot.mockResolvedValue({ revision: 'revision-1', records });
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', { apiKey: 'api-key', autoUploadQSO: true });

    const result = await provider.upload('BG5DRB', { trigger: 'auto', records });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(applyQsoBatch).toHaveBeenCalledTimes(1);
    expect(applyQsoBatch.mock.calls[0]?.[0]).toEqual([
      { type: 'update', qsoId: 'qso-1', updates: { qrzQslSent: 'Y', qrzQslSentDate: expect.any(Number) } },
      { type: 'update', qsoId: 'qso-2', updates: { qrzQslSent: 'Y', qrzQslSentDate: expect.any(Number) } },
    ]);
    expect(result).toMatchObject({ submitted: 2, uploaded: 2, failed: 0 });
    expect(notifyUpdated).toHaveBeenCalledOnce();
  });

  it('does not report remote acceptance as uploaded when the local batch fails', async () => {
    const { ctx, readQsoSnapshot, applyQsoBatch, notifyUpdated } = createContext(async () =>
      okResponse('RESULT=OK'),
    );
    const records = [createQso('qso-1'), createQso('qso-2')];
    readQsoSnapshot.mockResolvedValue({ revision: 'revision-1', records });
    applyQsoBatch.mockRejectedValue(new Error('fsync failed'));
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', { apiKey: 'api-key', autoUploadQSO: true });

    const result = await provider.upload('BG5DRB', { trigger: 'auto', records });

    expect(result).toMatchObject({ submitted: 2, uploaded: 0, failed: 2 });
    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'qrz_upload_logbook_failed', source: 'logbook' }),
    ]);
    expect(notifyUpdated).not.toHaveBeenCalled();
    expect(provider.getConfig('BG5DRB')?.lastSyncTime).toBeUndefined();
  });

  it('updates only confirmed QRZ matches and uses the remote confirmation date', async () => {
    const confirmedLocal = createQso('local-confirmed-target', {
      callsign: 'JA1ABC',
      startTime: Date.parse('2026-08-20T12:00:30Z'),
      endTime: Date.parse('2026-08-20T12:01:00Z'),
    });
    const unconfirmedLocal = createQso('local-unconfirmed-target', {
      callsign: 'JA1XYZ',
      startTime: Date.parse('2026-08-20T12:10:30Z'),
      endTime: Date.parse('2026-08-20T12:11:00Z'),
    });
    const { ctx, readQsoSnapshot, applyQsoBatch, notifyUpdated } = createContext(async () =>
      qrzDownloadResponse([
        { logId: 1, call: 'JA1ABC', qsoDate: '20260820', timeOn: '120000', status: 'C', qslDate: '20260821' },
        { logId: 2, call: 'JA1XYZ', qsoDate: '20260820', timeOn: '121000', status: 'N' },
      ]),
    );
    readQsoSnapshot.mockResolvedValue({
      revision: 'revision-1',
      records: [confirmedLocal, unconfirmedLocal],
    });
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', { apiKey: 'api-key', autoUploadQSO: true });

    const result = await provider.download('BG5DRB');

    expect(result).toEqual({
      downloaded: 2,
      matched: 2,
      updated: 1,
      imported: 0,
      failures: undefined,
    });
    expect(applyQsoBatch).toHaveBeenCalledOnce();
    expect(applyQsoBatch.mock.calls[0]?.[0]).toEqual([{
      type: 'update',
      qsoId: 'local-confirmed-target',
      updates: {
        qrzQslReceived: 'Y',
        qrzQslReceivedDate: Date.parse('2026-08-21T00:00:00Z'),
      },
    }]);
    expect(notifyUpdated).toHaveBeenCalledOnce();
  });

  it('selects the closest compatible QRZ candidate and imports unmatched records in one batch', async () => {
    const best = createQso('best', {
      callsign: 'JA1ABC',
      startTime: Date.parse('2026-08-20T12:00:20Z'),
    });
    const farther = createQso('farther', {
      callsign: 'JA1ABC',
      startTime: Date.parse('2026-08-20T12:01:30Z'),
    });
    const { ctx, readQsoSnapshot, applyQsoBatch } = createContext(async () =>
      qrzDownloadResponse([
        { logId: 1, call: 'JA1ABC', qsoDate: '20260820', timeOn: '120000', status: 'C' },
        { logId: 2, call: 'JA1NEW', qsoDate: '20260820', timeOn: '121000', status: 'N' },
      ]),
    );
    readQsoSnapshot.mockResolvedValue({ revision: 'revision-1', records: [farther, best] });
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', { apiKey: 'api-key', autoUploadQSO: true });

    const result = await provider.download('BG5DRB');

    expect(result).toMatchObject({ downloaded: 2, matched: 1, updated: 1, imported: 1 });
    expect(applyQsoBatch.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ type: 'update', qsoId: 'best' }),
      expect.objectContaining({ type: 'add', record: expect.objectContaining({ callsign: 'JA1NEW' }) }),
    ]);
  });

  it('replans a QRZ revision conflict without downloading the remote page again', async () => {
    const local = createQso('local', {
      callsign: 'JA1ABC',
      startTime: Date.parse('2026-08-20T12:00:00Z'),
    });
    const { ctx, readQsoSnapshot, applyQsoBatch, fetch } = createContext(async () =>
      qrzDownloadResponse([
        { logId: 1, call: 'JA1ABC', qsoDate: '20260820', timeOn: '120000', status: 'C' },
      ]),
    );
    readQsoSnapshot
      .mockResolvedValueOnce({ revision: 'revision-1', records: [local] })
      .mockResolvedValueOnce({ revision: 'revision-2', records: [local] });
    applyQsoBatch
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'LOGBOOK_REVISION_CONFLICT' }))
      .mockResolvedValueOnce({
        revision: 'revision-3',
        outcomes: [{ inputIndex: 0, status: 'updated', record: { ...local, qrzQslReceived: 'Y' } }],
      });
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', { apiKey: 'api-key', autoUploadQSO: true });

    const result = await provider.download('BG5DRB');

    expect(result.updated).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(readQsoSnapshot).toHaveBeenCalledTimes(2);
    expect(applyQsoBatch).toHaveBeenCalledTimes(2);
  });

  it('continues QRZ paging at highest log id plus one without skipping a record', async () => {
    const firstPage = Array.from({ length: 250 }, (_, index) => ({
      logId: index + 1,
      call: `JA${String(index + 1).padStart(3, '0')}A`,
      qsoDate: '20260820',
      timeOn: '120000',
      status: 'N',
    }));
    let request = 0;
    const { ctx, fetch, applyQsoBatch } = createContext(async (_input, init) => {
      request += 1;
      const body = decodeURIComponent(String(init?.body ?? ''));
      if (request === 1) {
        expect(body).toContain('AFTERLOGID:0');
        return qrzDownloadResponse(firstPage);
      }
      expect(body).toContain('AFTERLOGID:251');
      return qrzDownloadResponse([{
        logId: 251,
        call: 'JA251A',
        qsoDate: '20260820',
        timeOn: '120100',
        status: 'N',
      }]);
    });
    const provider = new QRZSyncProvider(ctx);
    provider.setConfig('BG5DRB', { apiKey: 'api-key', autoUploadQSO: true });

    const result = await provider.download('BG5DRB');

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ downloaded: 251, matched: 0, imported: 251 });
    expect(applyQsoBatch.mock.calls[0]?.[0]).toHaveLength(251);
  });
});
type PluginContext = PluginContextFor<readonly ['network', 'logbook:read', 'logbook:write']>;
