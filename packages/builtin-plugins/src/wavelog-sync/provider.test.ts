import { describe, expect, it, vi } from 'vitest';
import type { PluginContextFor, SyncStatus } from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import { convertQSOToADIF, parseADIFContent } from '@tx5dr/plugin-api';
import { WaveLogSyncProvider, buildWavelogQslStatusUpdates } from './provider.js';
import { qsoIdentity } from './qso-identity.js';

const time = Date.parse('2026-04-17T12:00:00Z');
function qso(id: string, n = 0): QSORecord {
  return { id, callsign: `N${n % 10}CALL`, myCallsign: 'BG5DRB', startTime: time + n * 60_000,
    endTime: time + n * 60_000, mode: 'FT8', frequency: 14_074_000, messageHistory: [] };
}
function fixture(version: 'v1' | 'v2' = 'v1', initial: QSORecord[] = [], remoteInitial: QSORecord[] = []) {
  const store = new Map<string, unknown>(); const files = new Map<string, Buffer>();
  let local = [...initial]; let revision = 0; let nextId = 1;
  const remote = remoteInitial.map(record => ({ id: nextId++, record }));
  const remoteKeys = new Set(remoteInitial.map(record => qsoIdentity(record, 'BG5DRB')));
  const calls: Array<{ path: string; method: string; init?: RequestInit }> = [];
  let postHook: ((records: QSORecord[]) => Response | Promise<Response>) | undefined;
  let cursorHook: ((cursor: number) => number) | undefined;
  let confirmations: Array<Record<string, unknown>> = [];
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url); const path = parsed.pathname; calls.push({ path, method: init?.method ?? 'GET', init });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/token')) return response({ data: { scopes: ['station:read', 'qso:read', 'qso:write', 'confirmation:read'] } });
    if (path.includes('/check_auth/')) return response({ rights: 'rw', status: 'valid' });
    if (path.includes('/station_info/')) return response([{ station_id: '1', station_profile_name: 'Home', station_callsign: 'BG5DRB' }]);
    if (path.endsWith('/station')) return response({ data: [{ id: 1, name: 'Home', callsign: 'BG5DRB' }] });
    if (path.endsWith('/confirmation')) return response({ data: confirmations, meta: { has_more: false } });
    if (path.endsWith('/get_contacts_adif') || path.endsWith('/qso') && !init?.body) {
      const cursor = Number(version === 'v2' ? parsed.searchParams.get('since_id') : body.fetchfromid);
      const rows = remote.filter(row => row.id > cursor).slice(0, 1000);
      const adif = rows.map(row => convertQSOToADIF(row.record, { includeStationCallsign: true })).join('\n');
      const next = cursorHook ? cursorHook(cursor) : rows.at(-1)?.id ?? cursor;
      const data = { adif: rows.length ? adif : null, lastfetchedid: next, [version === 'v2' ? 'exported' : 'exported_qsos']: rows.length };
      return response(version === 'v2' ? { data, meta: { total: remote.length } } : { ...data, status: 'successful' });
    }
    if (path.endsWith('/qso')) {
      const records = parseADIFContent(body.adif ?? body.string, 'remote', { resolveDxcc: false });
      if (postHook) return postHook(records);
      let skipped = 0;
      for (const record of records) {
        record.myCallsign = 'BG5DRB';
        const key = qsoIdentity(record, 'BG5DRB');
        if (remoteKeys.has(key)) skipped++;
        else { remoteKeys.add(key); remote.push({ id: nextId++, record }); }
      }
      if (version === 'v2') return response({ data: { parsed: records.length, imported: records.length - skipped, skipped, messages: [] } }, 201);
      return response({ status: skipped ? 'abort' : 'created', adif_count: records.length, adif_errors: skipped ? 1 : 0, messages: skipped ? ['Remote duplicate'] : [] }, skipped ? 400 : 201);
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const applyQsoBatch = vi.fn(async (mutations: Array<{ type: string; record?: QSORecord; qsoId?: string; updates?: Partial<QSORecord> }>, options: { expectedRevision: string }) => {
    if (options.expectedRevision !== String(revision)) throw Object.assign(new Error('revision conflict'), { code: 'LOGBOOK_REVISION_CONFLICT' });
    const next = [...local];
    const outcomes = mutations.map((mutation, inputIndex) => {
      if (mutation.type === 'add') { next.push(mutation.record!); return { inputIndex, status: 'added', record: mutation.record }; }
      const index = next.findIndex(record => record.id === mutation.qsoId);
      if (index < 0) throw new Error('QSO missing');
      next[index] = { ...next[index]!, ...mutation.updates };
      return { inputIndex, status: 'updated', record: next[index] };
    });
    local = next; revision++; return { revision: String(revision), outcomes };
  });
  const notifyUpdated = vi.fn(async () => {});
  const write = vi.fn(async (path: string, bytes: Buffer) => { files.set(path, Buffer.from(bytes)); });
  const ctx = {
    store: { global: { get: (key: string) => structuredClone(store.get(key)), set: (key: string, value: unknown) => { store.set(key, structuredClone(value)); }, flush: async () => {} } },
    files: { read: async (path: string) => files.get(path) ?? null, write },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, fetch,
    logbook: { forCallsign: () => ({ getLogBookId: async () => 'book-1', queryQSOs: async () => structuredClone(local),
      readQsoSnapshot: async () => ({ revision: String(revision), records: structuredClone(local) }), applyQsoBatch, notifyUpdated }) },
  } as unknown as PluginContextFor<readonly ['network', 'logbook:read', 'logbook:write']>;
  let provider = new WaveLogSyncProvider(ctx);
  provider.setConfig('BG5DRB', { url: 'https://example.test', apiKey: version === 'v2' ? 'wl2_test' : 'legacy-key', apiVersion: version, stationId: '1', autoUploadQSO: true });
  const run = async (operation: SyncStatus['operation'] = 'full_sync') => {
    let step = await provider.sync.begin('BG5DRB', operation, 'page-1');
    for (let i = 0; i < 300 && step.status.resumable && !['failed', 'partial_failure'].includes(step.status.state); i++) {
      await provider.sync.renew('BG5DRB', step.status.operationId, 'page-1');
      step = await provider.sync.advance('BG5DRB', step.status.operationId, step.step, 'page-1');
    }
    return step.status;
  };
  return { get provider() { return provider; }, restart: () => { provider = new WaveLogSyncProvider(ctx); },
    run, remote, calls, files, write, applyQsoBatch, notifyUpdated,
    addLocal: (record: QSORecord) => { local.push(record); revision++; }, get local() { return local; },
    updateLocal: (id: string, updates: Partial<QSORecord>) => { local = local.map(record => record.id === id ? { ...record, ...updates } : record); revision++; },
    setPostHook: (hook: typeof postHook) => { postHook = hook; }, setCursorHook: (hook: typeof cursorHook) => { cursorHook = hook; },
    setConfirmations: (rows: typeof confirmations) => { confirmations = rows; } };
}

describe('Wavelog identity and confirmations', () => {
  it('keeps two contacts eight minutes apart and normalizes only the own callsign suffix', async () => {
    const a = qso('a'); const b = { ...a, id: 'b', startTime: a.startTime + 8 * 60_000, endTime: a.startTime + 8 * 60_000 };
    const f = fixture('v1', [], [a, b]); expect((await f.run()).imported).toBe(2); expect(f.local).toHaveLength(2);
    expect(qsoIdentity({ ...a, myCallsign: 'BG5DRB/P' }, 'BG5DRB')).toBe(qsoIdentity(a, 'BG5DRB'));
    expect(qsoIdentity({ ...a, callsign: `${a.callsign}/P` }, 'BG5DRB')).not.toBe(qsoIdentity(a, 'BG5DRB'));
  });
  it('fills dates for the same status and never downgrades confirmations', () => {
    const local = { ...qso('a'), lotwQslReceived: 'Y' as const };
    expect(buildWavelogQslStatusUpdates(local, { ...local, lotwQslReceivedDate: time })).toEqual({ lotwQslReceivedDate: time });
    expect(buildWavelogQslStatusUpdates(local, { ...local, lotwQslReceived: 'N', lotwQslReceivedDate: time })).toBeNull();
  });
  it('treats ADIF MFSK/FT8 and FT8 as one contact identity', () => {
    const native = qso('native');
    expect(qsoIdentity({ ...native, mode: 'MFSK', submode: 'FT8' }, 'BG5DRB')).toBe(qsoIdentity(native, 'BG5DRB'));
    expect(qsoIdentity({ ...native, submode: 'FT8' }, 'BG5DRB')).toBe(qsoIdentity(native, 'BG5DRB'));
    expect(qsoIdentity({ ...native, mode: 'MFSK', submode: 'FT4' }, 'BG5DRB')).toBe(qsoIdentity({ ...native, mode: 'FT4' }, 'BG5DRB'));
    expect(qsoIdentity({ ...native, mode: 'MFSK', submode: 'FST4' }, 'BG5DRB')).not.toBe(qsoIdentity(native, 'BG5DRB'));
  });
});

describe.each(['v1', 'v2'] as const)('Wavelog %s synchronization', version => {
  it('downloads more than 20000 records in pages, then performs no uploads on repeated sync', async () => {
    const records = Array.from({ length: 20_010 }, (_, i) => qso(`q${i}`, i));
    const f = fixture(version, [], records);
    const first = await f.run(); expect(first.state).toBe('completed'); expect(first.imported).toBe(records.length);
    expect(f.local).toHaveLength(records.length);
    expect(f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body)).toHaveLength(0);
    expect((await f.run()).imported).toBe(0);
    expect(f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body)).toHaveLength(0);
  }, 30_000);
  it('uploads 10000 new contacts as 100 batches, and never uploads them again', async () => {
    const f = fixture(version, Array.from({ length: 10_000 }, (_, i) => qso(`q${i}`, i)));
    expect((await f.run()).uploaded).toBe(10_000);
    expect(f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body)).toHaveLength(100);
    expect((await f.run()).uploaded).toBe(0);
  }, 30_000);
  it('uploads historical additions even after an automatic upload advances recent activity', async () => {
    const f = fixture(version);
    const recent = qso('recent', 50_000); f.addLocal(recent);
    expect((await f.provider.upload('BG5DRB', { trigger: 'auto', records: [recent] })).uploaded).toBe(1);
    const historical = qso('old'); f.addLocal(historical);
    expect((await f.run()).uploaded).toBe(1); expect(f.remote).toHaveLength(2);
  });
  it('does not overwrite business fields when matching an existing QSO', async () => {
    const local = { ...qso('a'), comment: 'Keep local comment', grid: 'PM01AA' };
    const remote = { ...local, comment: 'Remote comment', grid: 'PM02BB', lotwQslReceived: 'Y' as const };
    const f = fixture(version, [local], [remote]); await f.run();
    expect(f.local[0]).toMatchObject({ comment: 'Keep local comment', grid: 'PM01AA', lotwQslReceived: 'Y' });
  });
  it('deduplicates repeated step requests, pauses safely, and resumes after restart', async () => {
    const f = fixture(version, [], [qso('a')]);
    const initial = await f.provider.sync.begin('BG5DRB', 'full_sync', 'page-1');
    const prepared = await f.provider.sync.advance('BG5DRB', initial.status.operationId, initial.step, 'page-1');
    const next = await f.provider.sync.advance('BG5DRB', prepared.status.operationId, prepared.step, 'page-1');
    const repeated = await f.provider.sync.advance('BG5DRB', prepared.status.operationId, prepared.step, 'page-1');
    expect(repeated.step).toBe(next.step); expect(f.local).toHaveLength(1);
    await f.provider.sync.pause('BG5DRB', initial.status.operationId, 'page-1');
    expect((await f.provider.getStatus('BG5DRB'))?.state).toBe('paused');
    f.restart(); expect((await f.provider.getStatus('BG5DRB'))?.state).toBe('interrupted');
    expect((await f.run()).state).toBe('completed'); expect(f.local).toHaveLength(1);
  });
  it('prevents a second page from stealing an active lease', async () => {
    const f = fixture(version); const started = await f.provider.sync.begin('BG5DRB', 'full_sync', 'one');
    await expect(f.provider.sync.begin('BG5DRB', 'full_sync', 'two')).rejects.toThrow('Another page');
    await expect(f.provider.sync.advance('BG5DRB', started.status.operationId, 0, 'two')).rejects.toThrow('lease');
  });
  it('projects an expired lease as paused without advancing work or making remote requests', async () => {
    const f = fixture(version); await f.provider.sync.begin('BG5DRB', 'full_sync', 'one');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 4000);
    try { expect((await f.provider.getStatus('BG5DRB'))?.state).toBe('paused'); expect(f.calls).toHaveLength(0); }
    finally { clock.mockRestore(); }
  });
  it('does not make an upload request resume an unrelated paused download', async () => {
    const f = fixture(version, [qso('a')]);
    const operation = await f.provider.sync.begin('BG5DRB', 'download', 'one');
    await f.provider.sync.pause('BG5DRB', operation.status.operationId, 'one');
    expect((await f.provider.upload('BG5DRB')).failures?.[0]?.message).toContain('different sync operation');
    expect(f.calls).toHaveLength(0);
  });
  it('keeps upload-only inventory from skipping a later download of missing remote records', async () => {
    const f = fixture(version, [], [qso('remote')]);
    expect((await f.run('upload')).imported).toBe(0);
    expect(f.local).toHaveLength(0);
    expect((await f.run('download')).imported).toBe(1);
    expect(f.local).toHaveLength(1);
  });
  it('keeps awaited legacy provider calls running through normal between-step waits', async () => {
    const f = fixture(version, [qso('local')], [qso('remote', 1)]);
    expect((await f.provider.upload('BG5DRB')).uploaded).toBe(1);
    expect(f.local).toHaveLength(1);
    expect((await f.provider.download('BG5DRB')).imported).toBe(1);
    expect(f.local).toHaveLength(2);
  });
  it('keeps identity edits local instead of importing the old copy or uploading another contact', async () => {
    const record = qso('local'); const f = fixture(version, [record]); await f.run();
    f.updateLocal('local', { startTime: record.startTime + 30_000, endTime: record.endTime! + 30_000, mode: 'FT4', notes: 'Local edit' });
    const status = await f.run('reconcile');
    expect(status.imported).toBe(0); expect(status.uploaded).toBe(0); expect(f.local).toHaveLength(1);
    expect(f.local[0]).toMatchObject({ mode: 'FT4', notes: 'Local edit', startTime: record.startTime + 30_000 });
    expect(f.remote).toHaveLength(1);
  });
  it('does not let an uncertain automatic record block later new contacts', async () => {
    const old = qso('old'); const recent = qso('new', 1); const f = fixture(version, [old, recent]);
    f.setPostHook(() => { throw new Error('Response lost'); });
    expect((await f.provider.upload('BG5DRB', { records: [old], trigger: 'auto' })).failed).toBe(1);
    f.setPostHook(undefined);
    expect(await f.provider.upload('BG5DRB', { records: [old, recent], trigger: 'auto' })).toMatchObject({ uploaded: 1, failed: 1 });
    expect(f.remote).toHaveLength(1);
  });
  it('does not notify or advance a cursor after a local atomic commit fails', async () => {
    const f = fixture(version, [], [qso('a')]);
    f.applyQsoBatch.mockRejectedValueOnce(new Error('Disk write failed'));
    const status = await f.run(); expect(status.state).toBe('failed'); expect(f.local).toHaveLength(0); expect(f.notifyUpdated).not.toHaveBeenCalled();
    expect((await f.run()).imported).toBe(1);
  });
  it('replays a page safely after checkpoint durability fails following the logbook commit', async () => {
    const f = fixture(version, [], [qso('a')]);
    const started = await f.provider.sync.begin('BG5DRB', 'full_sync', 'page-1');
    const prepared = await f.provider.sync.advance('BG5DRB', started.status.operationId, 0, 'page-1');
    f.write.mockRejectedValueOnce(new Error('Checkpoint disk failure'));
    await expect(f.provider.sync.advance('BG5DRB', started.status.operationId, prepared.step, 'page-1')).rejects.toThrow('Checkpoint');
    f.restart(); await f.run(); expect(f.local).toHaveLength(1);
  });
  it('fails closed on an invalid download cursor and allows explicit reconciliation of corrupt state', async () => {
    const f = fixture(version, [], [qso('a')]); f.setCursorHook(cursor => cursor);
    expect((await f.run()).state).toBe('failed'); expect(f.local).toHaveLength(0);
    f.setCursorHook(undefined); await f.run();
    const path = [...f.files.keys()][0]!; f.files.set(path, Buffer.from('{}')); f.restart();
    await expect(f.provider.getStatus('BG5DRB')).rejects.toThrow('checkpoint');
    expect((await f.run('reconcile')).state).toBe('completed'); expect(f.local).toHaveLength(1);
  });
  it('recovers an upload whose response was lost, without sending every record again', async () => {
    const f = fixture(version, [qso('a'), qso('b', 1)]);
    f.setPostHook(records => {
      for (const record of records) f.remote.push({ id: f.remote.length + 1, record: { ...record, myCallsign: 'BG5DRB' } });
      throw new Error('Response lost');
    });
    const status = await f.run(); expect(status.state).toBe('completed'); expect(status.uploaded).toBe(2);
    expect(f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body)).toHaveLength(1);
  });
  it('records a permanent remote refusal once and never retries it', async () => {
    const a = qso('a'); const b = { ...a, id: 'b', startTime: a.startTime + 15_000 };
    const f = fixture(version, [b], [a]);
    f.setPostHook(records => new Response(JSON.stringify(version === 'v1'
      ? { status: 'abort', adif_count: records.length, adif_errors: 1, messages: ['Duplikat'] }
      : { data: { parsed: records.length, imported: 0, skipped: records.length, messages: [] } }), { status: version === 'v1' ? 400 : 201 }));
    const status = await f.run();
    expect(status.state).toBe('completed'); expect(status.rejected).toBe(1);
    expect(status.failed).toBe(0); expect(status.conflicts).toBe(0);
    expect((await f.provider.sync.getDetails('BG5DRB', 0, status.operationId)).errors[0]?.qsoCallsign).toBe(b.callsign);
    expect(f.local.some(record => record.id === 'b')).toBe(true);
    const posts = f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body).length;
    expect(posts).toBeLessThanOrEqual(3);
    const again = await f.run();
    expect(again.state).toBe('completed'); expect(again.rejected).toBe(0); expect(again.uploaded).toBe(0);
    expect(f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body)).toHaveLength(posts);
    // An explicit reconcile re-verifies rejected records instead of trusting the ledger forever.
    await f.run('reconcile');
    expect(f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body).length).toBeGreaterThan(posts);
  });
  it('keeps a batch pending when the remote never confirmed it', async () => {
    const f = fixture(version, [qso('a')]);
    f.setPostHook(() => new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503 }));
    const status = await f.run();
    // A transient outage must never blacklist records.
    expect(status.rejected).toBe(0);
    expect(status.failed).toBeGreaterThan(0);
    f.setPostHook(undefined);
    const next = await f.run();
    expect(next.uploaded).toBe(1); expect(next.state).toBe('completed');
    expect(f.remote).toHaveLength(1);
  });
  it('never re-sends a batch whose manual outcome is still unresolved', async () => {
    const record = qso('a');
    const f = fixture('v2', [record]);
    f.setPostHook(() => new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503 }));
    let step = await f.provider.sync.begin('BG5DRB', 'upload', 'page');
    for (let i = 0; i < 6 && step.status.stage !== 'reconciling'; i++) {
      step = await f.provider.sync.advance('BG5DRB', step.status.operationId, step.step, 'page');
    }
    expect(step.status.stage).toBe('reconciling');
    await f.provider.sync.pause('BG5DRB', step.status.operationId, 'page');
    const posts = f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body).length;
    // The paused manual session still owns this identity; an automatic run must not duplicate it.
    const automatic = await f.provider.upload('BG5DRB', { trigger: 'auto', records: [record] });
    expect(automatic).toMatchObject({ uploaded: 0, skipped: 1, failed: 0 });
    expect(f.calls.filter(call => call.path.endsWith('/qso') && call.init?.body)).toHaveLength(posts);
  });
  it('refuses a configuration change while a sync session is unfinished', async () => {
    const f = fixture('v2', [qso('a')]);
    const started = await f.provider.sync.begin('BG5DRB', 'upload', 'page');
    await f.provider.sync.pause('BG5DRB', started.status.operationId, 'page');
    expect(() => f.provider.setConfig('BG5DRB', {
      url: 'https://example.test', apiKey: 'wl2_test', apiVersion: 'v2', stationId: '1', autoUploadQSO: true,
    })).toThrow(/Finish the current sync/);
  });
  it('retries a rejected contact after the user edits its identity', async () => {
    const a = qso('a'); const b = { ...a, id: 'b', startTime: a.startTime + 15_000 };
    const f = fixture('v2', [b], [a]);
    f.setPostHook(records => new Response(JSON.stringify({ data: { parsed: records.length, imported: 0, skipped: records.length, messages: [] } }), { status: 201 }));
    const status = await f.run(); expect(status.rejected).toBe(1);
    f.setPostHook(undefined);
    f.updateLocal('b', { startTime: a.startTime + 9 * 60_000, endTime: a.startTime + 9 * 60_000 });
    const edited = await f.run();
    expect(edited.uploaded).toBe(1); expect(edited.rejected).toBe(0);
  });
  it('keeps settings saves separate from cursor state and masks stored credentials', async () => {
    const f = fixture(version, [], [qso('a')]); await f.run();
    expect(f.provider.getPublicConfig('BG5DRB')).not.toHaveProperty('apiKey');
    f.provider.setConfig('BG5DRB', { url: 'https://example.test', apiKey: '', stationId: '1', apiVersion: version, autoUploadQSO: false });
    const calls = f.calls.length; await f.run();
    expect(f.calls.slice(calls).filter(call => call.path.endsWith('/get_contacts_adif') || call.path.endsWith('/qso') && !call.init?.body)).toHaveLength(1);
  });
});

it('refreshes v2 confirmations incrementally for a previously downloaded QSO', async () => {
  const a = qso('a'); const f = fixture('v2', [], [a]); await f.run();
  f.setConfirmations([{ qso_id: 1, callsign: a.callsign, qso_date: '2026-04-17 12:00:00', mode: 'FT8', band: '20m', type: 'LoTW', confirmation_date: '2026-04-18' }]);
  expect((await f.run()).updated).toBe(1); expect(f.local[0]?.lotwQslReceived).toBe('Y');
});

describe('automatic checkpoint commits', () => {
  it('durably commits POST intent then acceptance and final status in two writes', async () => {
    const record = qso('one'); const f = fixture('v2', [record]);
    const result = await f.provider.upload('BG5DRB', { trigger: 'auto', records: [record] });
    expect(result.uploaded).toBe(1); expect(f.write).toHaveBeenCalledTimes(2);
    const intent = JSON.parse(f.write.mock.calls[0]![1].toString());
    const final = JSON.parse(f.write.mock.calls[1]![1].toString());
    expect(intent.version).toBe(1); expect(intent.autoUncertain).toHaveLength(1);
    expect(intent.known).toEqual([]);
    expect(final.known).toHaveLength(1); expect(final.autoUncertain).toEqual([]);
    expect(final.autoStatus).toMatchObject({ state: 'completed', uploaded: 1 });
    f.restart(); expect((await f.provider.upload('BG5DRB', { trigger: 'auto', records: [record] })).uploaded).toBe(0);
    expect(f.remote).toHaveLength(1);
  });
});

describe('Wavelog inventory durability', () => {
  it('keeps the persisted inventory when a full scan fails before its first page', async () => {
    const f = fixture('v2', [], [qso('a')]);
    await f.run();
    const checkpointPath = [...f.files.keys()].find(path => path.includes('sync/'))!;
    const known = () => JSON.parse(f.files.get(checkpointPath)!.toString()).known as string[];
    expect(known()).toHaveLength(1);
    f.setCursorHook(cursor => cursor);
    const failed = await f.run('reconcile');
    expect(failed.state).toBe('failed');
    // Clearing the inventory before a readable page exists would force a blind re-upload.
    expect(known()).toHaveLength(1);
  });
});

describe('Wavelog confirmations', () => {
  it('matches a non-standard band by contact and skips malformed rows', async () => {
    const a = qso('a');
    const f = fixture('v2', [], [a]);
    await f.run();
    f.setConfirmations([
      { qso_id: 1, callsign: a.callsign, qso_date: '2026-04-17 12:00:00', mode: 'FT8', band: '23cm', type: 'LoTW', confirmation_date: '2026-04-18' },
      { qso_id: 2, callsign: a.callsign, qso_date: '2026-04-17 12:00:00', mode: 'FT8', band: '20m', type: 'WAT' },
    ]);
    const status = await f.run('download');
    expect(status.failed).toBe(1);
    expect(status.updated).toBe(1);
    expect(f.local[0]?.lotwQslReceived).toBe('Y');
  });
});

describe('Wavelog launch receipts', () => {
  it('declares three independent parameterized actions', () => {
    expect(fixture().provider.actions.map(action => action.pageParams)).toEqual([
      { operation: 'download', intent: 'start' }, { operation: 'upload', intent: 'start' }, { operation: 'full_sync', intent: 'start' },
    ]);
  });
  it('keeps reloads of a completed launch idempotent across restart', async () => {
    const f = fixture('v2', [qso('one')]);
    let step = await f.provider.sync.begin('BG5DRB', 'upload', 'page', 'click-one');
    const id = step.status.operationId;
    while (step.status.resumable) step = await f.provider.sync.advance('BG5DRB', id, step.step, 'page');
    const count = f.calls.length;
    f.restart();
    const repeated = await f.provider.sync.begin('BG5DRB', 'upload', 'reload', 'click-one');
    expect(repeated.status.operationId).toBe(id); expect(repeated.status.state).toBe('completed');
    expect(f.calls).toHaveLength(count);
    await f.provider.sync.begin('BG5DRB', 'download', 'page-new', 'click-two');
    f.restart();
    const historical = await f.provider.sync.begin('BG5DRB', 'upload', 'page-old', 'click-one');
    expect(historical.status).toMatchObject({ operationId: id, state: 'completed', uploaded: 1 });
    expect(f.calls).toHaveLength(count);
  });
  it('does not let a competing page or different operation replace an active session', async () => {
    const f = fixture();
    const first = await f.provider.sync.begin('BG5DRB', 'download', 'page', 'first');
    await expect(f.provider.sync.begin('BG5DRB', 'download', 'other', 'second')).rejects.toThrow('Another page');
    await f.provider.sync.pause('BG5DRB', first.status.operationId, 'page');
    await expect(f.provider.sync.begin('BG5DRB', 'upload', 'page', 'third')).rejects.toThrow('different sync');
    await expect(f.provider.sync.begin('BG5DRB', 'reconcile', 'page', 'fourth')).rejects.toThrow('different sync');
  });
  it('keeps the last manual result when an automatic upload completes afterwards', async () => {
    const f = fixture(); const manual = await f.run(); const fresh = qso('new'); f.addLocal(fresh);
    await f.provider.upload('BG5DRB', { trigger: 'auto', records: [fresh] });
    expect(await f.provider.getStatus('BG5DRB')).toMatchObject({ operationId: manual.operationId, trigger: 'manual', automaticUpload: { uploaded: 1 } });
  });
});
