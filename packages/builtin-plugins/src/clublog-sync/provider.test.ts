import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginContext } from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import { ClubLogSyncProvider } from './provider.js';

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
    fetch: ctx.fetch,
    queryQSOs,
    store,
  };
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function withApiKey(value = 'developer-api-key') {
  process.env.TX5DR_CLUBLOG_API_KEY = value;
}

function configure(provider: ClubLogSyncProvider) {
  provider.setConfig('BG5DRB', {
    email: 'ham@example.com',
    password: 'app-password',
    autoUploadQSO: true,
  });
}

describe('ClubLogSyncProvider', () => {
  afterEach(() => {
    delete process.env.TX5DR_CLUBLOG_API_KEY;
    vi.restoreAllMocks();
  });

  it('requires developer API key in addition to user credentials', async () => {
    const { ctx } = createContext(async () => textResponse('QSO OK'));
    const provider = new ClubLogSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      email: 'ham@example.com',
      password: 'app-password',
      autoUploadQSO: true,
    });

    expect(provider.isConfigured('BG5DRB')).toBe(false);
    const result = await provider.upload('BG5DRB', { trigger: 'auto', records: [createQso('qso-1')] });

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'clublog_api_key_unavailable',
        providerId: 'clublog',
      }),
    ]);
  });

  it('auto-upload uses explicit records and posts a realtime form', async () => {
    withApiKey();
    const { ctx, fetch, queryQSOs } = createContext(async () => textResponse('QSO OK'));
    const provider = new ClubLogSyncProvider(ctx);
    configure(provider);

    const result = await provider.upload('BG5DRB', { trigger: 'auto', records: [createQso('qso-1')] });

    expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 0, failures: undefined });
    expect(queryQSOs).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://clublog.org/realtime.php');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const body = init?.body as URLSearchParams;
    expect(body.get('email')).toBe('ham@example.com');
    expect(body.get('password')).toBe('app-password');
    expect(body.get('callsign')).toBe('BG5DRB');
    expect(body.get('api')).toBe('developer-api-key');
    expect(body.get('adif')).toContain('<EOR>');
  });

  it('treats duplicate realtime responses as skipped and remembers them', async () => {
    withApiKey();
    const { ctx, fetch } = createContext(async () => textResponse('QSO Duplicate'));
    const provider = new ClubLogSyncProvider(ctx);
    configure(provider);
    const qso = createQso('qso-1');

    const first = await provider.upload('BG5DRB', { trigger: 'auto', records: [qso] });
    const second = await provider.upload('BG5DRB', { trigger: 'auto', records: [qso] });

    expect(first.uploaded).toBe(0);
    expect(first.skipped).toBe(1);
    expect(second.skipped).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops realtime upload on forbidden response', async () => {
    withApiKey();
    const { ctx, fetch } = createContext(async () => textResponse('Forbidden', 403));
    const provider = new ClubLogSyncProvider(ctx);
    configure(provider);

    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [createQso('qso-1'), createQso('qso-2')],
    });

    expect(result.failed).toBe(1);
    expect(result.failures?.[0]).toEqual(expect.objectContaining({
      code: 'clublog_upload_forbidden',
      httpStatus: 403,
      retryable: false,
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not leak secrets in failures', async () => {
    withApiKey('secret-api-key');
    const { ctx } = createContext(async () => textResponse('Rejected secret-api-key app-password ham@example.com', 400));
    const provider = new ClubLogSyncProvider(ctx);
    configure(provider);

    const result = await provider.upload('BG5DRB', { trigger: 'auto', records: [createQso('qso-1')] });
    const failureText = JSON.stringify(result.failures);

    expect(failureText).not.toContain('secret-api-key');
    expect(failureText).not.toContain('app-password');
    expect(failureText).not.toContain('ham@example.com');
    expect(failureText).toContain('[redacted]');
  });

  it('manual upload submits batch ADIF and skips ledger entries later', async () => {
    withApiKey();
    const { ctx, fetch, queryQSOs } = createContext(async () => textResponse('File queued'));
    const provider = new ClubLogSyncProvider(ctx);
    configure(provider);
    const qso = createQso('qso-1');
    queryQSOs.mockResolvedValue([qso]);

    const first = await provider.upload('BG5DRB', { trigger: 'manual' });
    const second = await provider.upload('BG5DRB', { trigger: 'manual' });

    expect(first).toEqual({ submitted: 1, uploaded: 1, skipped: 0, failed: 0, failures: undefined });
    expect(second.uploaded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://clublog.org/putlogs.php');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('email')).toBe('ham@example.com');
    expect(form.get('password')).toBe('app-password');
    expect(form.get('callsign')).toBe('BG5DRB');
    expect(form.get('api')).toBe('developer-api-key');
    expect(form.get('clear')).toBe('0');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('preflight reports blocked callsign mismatches', async () => {
    withApiKey();
    const { ctx, queryQSOs } = createContext(async () => textResponse('File queued'));
    const provider = new ClubLogSyncProvider(ctx);
    configure(provider);
    queryQSOs.mockResolvedValue([createQso('qso-1', { myCallsign: 'OTHER' })]);

    const preflight = await provider.getUploadPreflight('BG5DRB');

    expect(preflight.ready).toBe(false);
    expect(preflight.pendingCount).toBe(1);
    expect(preflight.uploadableCount).toBe(0);
    expect(preflight.blockedCount).toBe(1);
    expect(preflight.issues).toEqual([
      expect.objectContaining({ code: 'clublog_qso_callsign_mismatch', severity: 'error' }),
    ]);
  });
});
