import { describe, expect, it, vi } from 'vitest';
import { constants, createHash, generateKeyPairSync, publicDecrypt } from 'crypto';

import type { PluginContext } from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import { LoTWSyncProvider } from './provider.js';

type MockLoTWContext = PluginContext & {
  fetch: ReturnType<typeof vi.fn>;
  files: {
    delete: ReturnType<typeof vi.fn>;
  };
};

type LoTWProviderInternals = {
  signLog(privateKeyPem: string, signData: string): string;
  prepareUpload(...args: unknown[]): Promise<unknown>;
  resolveUploadLocation(...args: unknown[]): unknown;
  uploadBatch(...args: unknown[]): Promise<unknown>;
  buildTq8Content(...args: unknown[]): string;
};

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
  const files = new Map<string, Buffer>();
  const queryQSOs = vi.fn(async (_filter?: unknown) => [] as QSORecord[]);
  const updateQSO = vi.fn(async () => undefined);
  const addQSO = vi.fn(async () => undefined);
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
        updateQSO,
        addQSO,
        notifyUpdated,
      })),
    },
    files: {
      read: vi.fn(async (path: string) => files.get(path) ?? null),
      write: vi.fn(async (path: string, data: Buffer) => {
        files.set(path, data);
      }),
      list: vi.fn(async (prefix?: string) => {
        const paths = Array.from(files.keys());
        return prefix ? paths.filter((path) => path.startsWith(prefix)) : paths;
      }),
      delete: vi.fn(async (path: string) => files.delete(path)),
    },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    fetch: vi.fn(),
  };

  return {
    ctx: ctx as unknown as MockLoTWContext,
    files,
    queryQSOs,
    updateQSO,
    addQSO,
    notifyUpdated,
  };
}

function lotwResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-arrl-adif; charset=iso-8859-1' },
  });
}

function configureProvider(provider: LoTWSyncProvider): void {
  provider.setConfig('BG5DRB', {
    username: 'user',
    password: 'pass',
    uploadLocation: {
      callsign: 'BG5DRB',
      dxccId: 291,
      gridSquare: 'PM01AA',
      cqZone: '24',
      ituZone: '44',
      state: 'CA',
      county: 'Santa Clara',
    },
    autoUploadQSO: false,
  });
}

function createStoredCertificate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'current-cert',
    callsign: 'BG5DRB',
    dxccId: 291,
    serial: '1234',
    validFrom: Date.parse('2025-01-01T00:00:00.000Z'),
    validTo: Date.parse('2027-01-01T00:00:00.000Z'),
    qsoStartDate: Date.parse('2025-01-01T00:00:00.000Z'),
    qsoEndDate: Date.parse('2027-01-01T23:59:59.999Z'),
    fingerprint: 'ABCDEF',
    certPem: 'cert',
    privateKeyPem: 'key',
    ...overrides,
  };
}

describe('LoTWSyncProvider', () => {
  it('signs LoTW payloads without relying on OpenSSL SHA1 digest providers', () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const internals = provider as unknown as LoTWProviderInternals;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const signData = '20MN0CALL14.074FT82026-04-1712:00:00Z';

    const signature = Buffer.from(
      internals.signLog(
        privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        signData,
      ),
      'base64',
    );

    const decrypted = publicDecrypt(
      { key: publicKey.export({ type: 'spki', format: 'pem' }).toString(), padding: constants.RSA_PKCS1_PADDING },
      signature,
    );
    const expectedDigestInfo = Buffer.concat([
      Buffer.from('3021300906052b0e03021a05000414', 'hex'),
      createHash('sha1').update(signData, 'utf8').digest(),
    ]);
    expect(decrypted).toEqual(expectedDigestInfo);
  });

  it('uses the certificate file name as the ID for legacy certificates without stored IDs', async () => {
    const { ctx, files } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const filePath = 'callsigns/BG5DRB/certificates/legacy-cert.json';
    const legacyCertificate = createStoredCertificate();
    delete legacyCertificate.id;
    files.set(filePath, Buffer.from(JSON.stringify(legacyCertificate), 'utf-8'));

    const certificates = await provider.getCertificates('BG5DRB');

    expect(certificates).toHaveLength(1);
    expect(certificates[0].id).toBe('legacy-cert');
    await expect(provider.deleteCertificate('BG5DRB', certificates[0].id)).resolves.toBe(true);
    expect(files.has(filePath)).toBe(false);
  });

  it('prefers the certificate file name over stale stored IDs', async () => {
    const { ctx, files } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const filePath = 'callsigns/BG5DRB/certificates/file-cert.json';
    files.set(
      filePath,
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'stale-cert' })), 'utf-8'),
    );

    const certificates = await provider.getCertificates('BG5DRB');

    expect(certificates).toHaveLength(1);
    expect(certificates[0].id).toBe('file-cert');
    expect(JSON.parse(files.get(filePath)!.toString('utf-8')).id).toBe('file-cert');
    await expect(provider.deleteCertificate('BG5DRB', certificates[0].id)).resolves.toBe(true);
    expect(files.has(filePath)).toBe(false);
    expect(ctx.files.delete).toHaveBeenCalledWith(filePath);
  });

  it('deletes a certificate when the UI passes a stale stored ID', async () => {
    const { ctx, files } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const filePath = 'callsigns/BG5DRB/certificates/file-cert.json';
    files.set(
      filePath,
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'stale-cert' })), 'utf-8'),
    );

    await expect(provider.deleteCertificate('BG5DRB', 'stale-cert')).resolves.toBe(true);

    expect(files.has(filePath)).toBe(false);
    expect(ctx.files.delete).toHaveBeenCalledWith(filePath);
  });

  it('treats deletion of an already-missing certificate as successful', async () => {
    const { ctx, files } = createContext();
    const provider = new LoTWSyncProvider(ctx);

    await expect(provider.deleteCertificate('BG5DRB', 'ghost-cert')).resolves.toBe(true);

    expect(files.size).toBe(0);
    expect(ctx.files.delete).toHaveBeenCalledWith('callsigns/BG5DRB/certificates/ghost-cert.json');
  });

  it('does not report missing certificate files during preflight when stored IDs are stale', async () => {
    const { ctx, files, queryQSOs } = createContext();
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
        state: 'CA',
        county: 'Santa Clara',
      },
      autoUploadQSO: false,
    });
    files.set(
      'callsigns/BG5DRB/certificates/file-cert.json',
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'stale-cert' })), 'utf-8'),
    );
    queryQSOs.mockResolvedValue([createQso('qso-1')]);

    const result = await provider.getUploadPreflight('BG5DRB');

    expect(result.ready).toBe(true);
    expect(result.uploadableCount).toBe(1);
    expect(result.matchedCertificateIds).toEqual(['file-cert']);
    expect(result.issues.map((issue) => issue.message)).not.toContain('Certificate file is missing on disk');
  });

  it('lists the specific QSO when upload preflight cannot match a certificate', async () => {
    const { ctx, files, queryQSOs } = createContext();
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
        state: 'CA',
        county: 'Santa Clara',
      },
      autoUploadQSO: false,
    });
    files.set(
      'callsigns/BG5DRB/certificates/china-cert.json',
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'china-cert', dxccId: 318 })), 'utf-8'),
    );
    queryQSOs.mockResolvedValue([createQso('qso-1', { callsign: 'N0CALL' })]);

    const result = await provider.getUploadPreflight('BG5DRB');

    const issue = result.issues.find((item) => item.code === 'certificate_date_range_mismatch');
    expect(result.ready).toBe(false);
    expect(result.blockedCount).toBe(1);
    expect(issue).toMatchObject({
      code: 'certificate_date_range_mismatch',
      severity: 'error',
      qsoId: 'qso-1',
      qsoCallsign: 'N0CALL',
    });
    expect(issue?.message).toContain('N0CALL');
    expect(issue?.detail).toContain('qsoId=qso-1');
    expect(issue?.detail).toContain('stationCallsign=BG5DRB');
    expect(issue?.detail).toContain('uploadDxcc=291');
    expect(issue?.detail).toContain('dxcc=318');
  });

  it('marks preflight blockers as skippable when other QSOs can still upload', async () => {
    const { ctx, files, queryQSOs } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    files.set(
      'callsigns/BG5DRB/certificates/current-cert.json',
      Buffer.from(JSON.stringify(createStoredCertificate()), 'utf-8'),
    );
    queryQSOs.mockResolvedValue([
      createQso('qso-uploadable', { startTime: Date.parse('2026-04-17T12:00:00.000Z') }),
      createQso('qso-blocked', { startTime: Date.parse('2024-04-17T12:00:00.000Z') }),
    ]);

    const result = await provider.getUploadPreflight('BG5DRB');

    expect(result.ready).toBe(false);
    expect(result.uploadableCount).toBe(1);
    expect(result.blockedCount).toBe(1);
    expect(result.canSkipBlocked).toBe(true);
  });

  it('blocks upload before TQ8 generation when China province is not an ADIF code or alias', async () => {
    const { ctx, files } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      username: 'user',
      password: 'pass',
      uploadLocation: {
        callsign: 'BG5DRB',
        dxccId: 318,
        gridSquare: 'PL09RX',
        cqZone: '24',
        ituZone: '44',
        state: 'ZHEJIANGG',
      },
      autoUploadQSO: false,
    });
    files.set(
      'callsigns/BG5DRB/certificates/china-cert.json',
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'china-cert', dxccId: 318 })), 'utf-8'),
    );
    const internals = provider as unknown as LoTWProviderInternals;
    const uploadBatch = vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.now(), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB', {
      records: [createQso('qso-1', { myGrid: 'PL09RX' })],
    });

    expect(result).toMatchObject({ uploaded: 0, skipped: 0, failed: 1 });
    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'lotw_location_state_invalid',
        operation: 'preflight',
        detail: expect.stringContaining('field=CN_PROVINCE'),
      }),
    ]);
    expect(uploadBatch).not.toHaveBeenCalled();
  });

  it('warns when QSO MY_* station fields differ from the upload station location', async () => {
    const { ctx, files, queryQSOs } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    provider.setConfig('BG5DRB', {
      username: 'user',
      password: 'pass',
      uploadLocation: {
        callsign: 'BG5DRB',
        dxccId: 318,
        gridSquare: 'PL09SV',
        cqZone: '24',
        ituZone: '44',
        state: 'ZJ',
      },
      autoUploadQSO: false,
    });
    files.set(
      'callsigns/BG5DRB/certificates/china-cert.json',
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'china-cert', dxccId: 318 })), 'utf-8'),
    );
    queryQSOs.mockResolvedValue([createQso('qso-1', {
      callsign: 'JA2HYD',
      myGrid: 'PL09RX',
      myDxccId: 318,
      myCqZone: 24,
      myItuZone: 44,
      myState: 'ZHEJIANG',
    })]);

    const result = await provider.getUploadPreflight('BG5DRB');

    expect(result.uploadableCount).toBe(1);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'lotw_location_grid_mismatch',
        severity: 'warning',
        qsoId: 'qso-1',
        qsoCallsign: 'JA2HYD',
        detail: expect.stringContaining('MY_GRIDSQUARE: qso=PL09RX, station=PL09SV'),
      }),
    ]));
  });

  it('deletes only the targeted certificate when multiple certificates exist', async () => {
    const { ctx, files } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const targetPath = 'callsigns/BG5DRB/certificates/target-cert.json';
    const otherPath = 'callsigns/BG5DRB/certificates/other-cert.json';
    files.set(
      targetPath,
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'stale-target' })), 'utf-8'),
    );
    files.set(
      otherPath,
      Buffer.from(JSON.stringify(createStoredCertificate({ id: 'other-cert', fingerprint: '123456' })), 'utf-8'),
    );

    await expect(provider.deleteCertificate('BG5DRB', 'stale-target')).resolves.toBe(true);

    expect(files.has(targetPath)).toBe(false);
    expect(files.has(otherPath)).toBe(true);
  });

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
    const internals = provider as unknown as LoTWProviderInternals;
    const prepareUpload = vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [
        {
          qsos: [qso],
          certificate: { callsign: 'BG5DRB' },
        },
      ],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    const uploadBatch = vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.now(), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [qso, createQso('qso-2', { lotwQslSent: 'Y' })],
    });

    expect(result).toMatchObject({ submitted: 1, uploaded: 1, skipped: 0, failed: 0, failures: undefined });
    expect(result.verified).toBeUndefined();
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
    const internals = provider as unknown as LoTWProviderInternals;
    const prepareUpload = vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [
        {
          qsos: [qso],
          certificate: { callsign: 'BG5DRB' },
        },
      ],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.now(), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB');

    expect(result.uploaded).toBe(1);
    expect(queryQSOs).toHaveBeenCalledTimes(1);
    expect(queryQSOs).toHaveBeenCalledWith({});
    expect(prepareUpload).toHaveBeenCalledWith(expect.anything(), [qso], 'BG5DRB');
  });

  it('manual upload filters pending QSOs by the selected upload date range', async () => {
    const { ctx, queryQSOs, updateQSO } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const inRange = createQso('qso-in-range', { startTime: Date.parse('2026-04-17T12:00:00.000Z') });
    const tooOld = createQso('qso-too-old', { startTime: Date.parse('2026-04-10T12:00:00.000Z') });
    const alreadySent = createQso('qso-sent', {
      startTime: Date.parse('2026-04-17T13:00:00.000Z'),
      lotwQslSent: 'Y',
    });
    queryQSOs.mockResolvedValue([tooOld, inRange, alreadySent]);
    const internals = provider as unknown as LoTWProviderInternals;
    const prepareUpload = vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [{ qsos: [inRange], certificate: { callsign: 'BG5DRB' } }],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.now(), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB', {
      since: Date.parse('2026-04-15T00:00:00.000Z'),
      until: Date.parse('2026-04-20T23:59:59.999Z'),
    });

    expect(result).toMatchObject({ submitted: 1, uploaded: 1, failed: 0 });
    expect(prepareUpload).toHaveBeenCalledWith(expect.anything(), [inRange], 'BG5DRB');
    expect(updateQSO).toHaveBeenCalledWith('qso-in-range', {
      lotwQslSent: 'Y',
      lotwQslSentDate: expect.any(Number),
    });
    expect(updateQSO).toHaveBeenCalledTimes(1);
  });

  it('manual upload can include QSOs already marked as uploaded when requested', async () => {
    const { ctx, queryQSOs, updateQSO } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const unsent = createQso('qso-unsent', { startTime: Date.parse('2026-04-17T12:00:00.000Z') });
    const alreadySent = createQso('qso-sent', {
      startTime: Date.parse('2026-04-17T13:00:00.000Z'),
      lotwQslSent: 'Y',
    });
    queryQSOs.mockResolvedValue([unsent, alreadySent]);
    const internals = provider as unknown as LoTWProviderInternals;
    const prepareUpload = vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [{ qsos: [unsent, alreadySent], certificate: { callsign: 'BG5DRB' } }],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.now(), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB', {
      since: Date.parse('2026-04-15T00:00:00.000Z'),
      until: Date.parse('2026-04-20T23:59:59.999Z'),
      includeAlreadyUploaded: true,
    });

    expect(result).toMatchObject({ submitted: 2, uploaded: 2, failed: 0 });
    expect(prepareUpload).toHaveBeenCalledWith(expect.anything(), [unsent, alreadySent], 'BG5DRB');
    expect(updateQSO).toHaveBeenCalledWith('qso-unsent', expect.objectContaining({ lotwQslSent: 'Y' }));
    expect(updateQSO).toHaveBeenCalledWith('qso-sent', expect.objectContaining({ lotwQslSent: 'Y' }));
  });

  it('upload preflight filters blockers by the selected upload date range', async () => {
    const { ctx, queryQSOs } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const inRange = createQso('qso-in-range', { startTime: Date.parse('2026-04-17T12:00:00.000Z') });
    const tooOld = createQso('qso-too-old', { startTime: Date.parse('2026-04-10T12:00:00.000Z') });
    queryQSOs.mockResolvedValue([tooOld, inRange]);
    const internals = provider as unknown as LoTWProviderInternals;
    const prepareUpload = vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      guidance: [],
      matchedCertificates: [],
      blockedCount: 0,
      uploadableCount: 1,
      batches: [{ qsos: [inRange], certificate: { callsign: 'BG5DRB' } }],
    });

    const result = await provider.getUploadPreflight('BG5DRB', {
      since: Date.parse('2026-04-15T00:00:00.000Z'),
      until: Date.parse('2026-04-20T23:59:59.999Z'),
    });

    expect(result.pendingCount).toBe(1);
    expect(result.uploadableCount).toBe(1);
    expect(prepareUpload).toHaveBeenCalledWith(expect.anything(), [inRange], 'BG5DRB');
  });

  it('upload preflight can include already-uploaded QSOs when requested', async () => {
    const { ctx, queryQSOs } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const unsent = createQso('qso-unsent', { startTime: Date.parse('2026-04-17T12:00:00.000Z') });
    const alreadySent = createQso('qso-sent', {
      startTime: Date.parse('2026-04-17T13:00:00.000Z'),
      lotwQslSent: 'Y',
    });
    queryQSOs.mockResolvedValue([unsent, alreadySent]);
    const internals = provider as unknown as LoTWProviderInternals;
    const prepareUpload = vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      guidance: [],
      matchedCertificates: [],
      blockedCount: 0,
      uploadableCount: 2,
      batches: [{ qsos: [unsent, alreadySent], certificate: { callsign: 'BG5DRB' } }],
    });

    const result = await provider.getUploadPreflight('BG5DRB', {
      since: Date.parse('2026-04-15T00:00:00.000Z'),
      until: Date.parse('2026-04-20T23:59:59.999Z'),
      includeAlreadyUploaded: true,
    });

    expect(result.pendingCount).toBe(2);
    expect(result.uploadableCount).toBe(2);
    expect(prepareUpload).toHaveBeenCalledWith(expect.anything(), [unsent, alreadySent], 'BG5DRB');
  });

  it('can skip certificate-blocked QSOs and upload the remaining prepared QSOs', async () => {
    const { ctx, files, updateQSO } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    files.set(
      'callsigns/BG5DRB/certificates/current-cert.json',
      Buffer.from(JSON.stringify(createStoredCertificate()), 'utf-8'),
    );
    const uploadable = createQso('qso-uploadable', {
      callsign: 'N0CALL',
      startTime: Date.parse('2026-04-17T12:00:00.000Z'),
    });
    const blocked = createQso('qso-blocked', {
      callsign: 'K1BAD',
      startTime: Date.parse('2024-04-17T12:00:00.000Z'),
    });
    const internals = provider as unknown as LoTWProviderInternals;
    const uploadBatch = vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.now(), responseSummary: 'accepted' });
    const progress: Array<{ stage: string; batchIndex?: number; batchCount?: number }> = [];

    const result = await provider.upload('BG5DRB', {
      trigger: 'manual',
      records: [uploadable, blocked],
      skipBlockedQsos: true,
      onProgress: (next) => progress.push(next),
    });

    expect(result).toMatchObject({ submitted: 1, uploaded: 1, skipped: 1, failed: 0 });
    expect(result.verified).toBeUndefined();
    expect(uploadBatch).toHaveBeenCalledTimes(1);
    expect((uploadBatch.mock.calls[0][0] as { qsos: QSORecord[] }).qsos).toEqual([uploadable]);
    expect(updateQSO).toHaveBeenCalledWith('qso-uploadable', {
      lotwQslSent: 'Y',
      lotwQslSentDate: expect.any(Number),
    });
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'prepared', batchCount: 1 }),
      expect.objectContaining({ stage: 'batch_uploading', batchIndex: 1, batchCount: 1 }),
      expect.objectContaining({ stage: 'batch_accepted', batchIndex: 1, batchCount: 1 }),
      expect.objectContaining({ stage: 'finished' }),
    ]));
    expect(progress.map((item) => item.stage)).not.toContain('batch_verifying');
    expect(progress.map((item) => item.stage)).not.toContain('batch_verified');
  });

  it('marks accepted uploads as sent without querying LoTW reports', async () => {
    const { ctx, updateQSO } = createContext();
    ctx.fetch.mockImplementation(async () => lotwResponse('ARRL Logbook of the World Status Report\n<eoh>\n'));
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const qso = createQso('qso-1');
    const internals = provider as unknown as LoTWProviderInternals;
    vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [{ qsos: [qso], certificate: { callsign: 'BG5DRB' } }],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.parse('2026-04-17T12:02:00.000Z'), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB', { records: [qso] });

    expect(result).toMatchObject({ submitted: 1, uploaded: 1, failed: 0 });
    expect(result.verified).toBeUndefined();
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(updateQSO).toHaveBeenCalledWith('qso-1', {
      lotwQslSent: 'Y',
      lotwQslSentDate: expect.any(Number),
    });
  });

  it('reports local sent-status update failures after LoTW accepts a batch', async () => {
    const { ctx, updateQSO } = createContext();
    updateQSO.mockRejectedValue(new Error('local db is locked'));
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const qso = createQso('qso-1');
    const internals = provider as unknown as LoTWProviderInternals;
    vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [{ qsos: [qso], certificate: { callsign: 'BG5DRB' } }],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.parse('2026-04-17T12:02:00.000Z'), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB', { records: [qso] });

    expect(result).toMatchObject({ submitted: 1, uploaded: 0, failed: 1 });
    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'lotw_update_qsl_status_failed',
        qsoId: 'qso-1',
        message: 'local db is locked',
      }),
    ]);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('splits large upload batches before submitting to LoTW', async () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const qsos = Array.from({ length: 101 }, (_, index) => createQso(`qso-${index + 1}`, {
      startTime: Date.parse('2026-04-17T12:00:00.000Z') + index * 60000,
    }));
    const internals = provider as unknown as LoTWProviderInternals;
    vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [{ qsos, certificate: { callsign: 'BG5DRB' } }],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    const uploadBatch = vi.spyOn(internals, 'uploadBatch').mockResolvedValue({ acceptedAt: Date.now(), responseSummary: 'accepted' });

    const result = await provider.upload('BG5DRB', { records: qsos });

    expect(result).toMatchObject({ submitted: 101, uploaded: 101, failed: 0 });
    expect(result.verified).toBeUndefined();
    expect(uploadBatch).toHaveBeenCalledTimes(2);
    expect((uploadBatch.mock.calls[0][0] as { qsos: QSORecord[] }).qsos).toHaveLength(100);
    expect((uploadBatch.mock.calls[1][0] as { qsos: QSORecord[] }).qsos).toHaveLength(1);
  });

  it('projects SSB sideband records to LoTW contact mode SSB', () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const internals = provider as unknown as LoTWProviderInternals;
    vi.spyOn(internals, 'signLog').mockReturnValue('A'.repeat(88));

    const tq8 = internals.buildTq8Content(
      [createQso('voice-usb', {
        frequency: 14_270_000,
        mode: 'SSB',
        submode: 'USB',
        reportSent: '59',
        reportReceived: '59',
      })],
      createStoredCertificate({
        certPem: '-----BEGIN CERTIFICATE-----\\nCERTDATA\\n-----END CERTIFICATE-----',
        privateKeyPem: 'key',
      }),
      {
        callsign: 'BG5DRB',
        dxccId: 291,
        gridSquare: 'PM01AA',
        cqZone: '24',
        ituZone: '44',
        iota: '',
        state: '',
        county: '',
      },
    );

    expect(tq8).toContain('<MODE:3>SSB');
    expect(tq8).toContain('<SIGNDATA:');
    expect(tq8).toContain('20MN0CALL14.27SSB2026-04-1712:00:00Z');
    expect(tq8).not.toContain('<MODE:3>USB');
    expect(tq8).not.toContain('14.27USB');
  });

  it('projects legacy USB records to LoTW contact mode SSB', () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const internals = provider as unknown as LoTWProviderInternals;
    vi.spyOn(internals, 'signLog').mockReturnValue('A'.repeat(88));

    const tq8 = internals.buildTq8Content(
      [createQso('legacy-usb', { frequency: 14_270_000, mode: 'USB' })],
      createStoredCertificate({
        certPem: '-----BEGIN CERTIFICATE-----\\nCERTDATA\\n-----END CERTIFICATE-----',
        privateKeyPem: 'key',
      }),
      {
        callsign: 'BG5DRB',
        dxccId: 291,
        gridSquare: 'PM01AA',
        cqZone: '24',
        ituZone: '44',
        iota: '',
        state: '',
        county: '',
      },
    );

    expect(tq8).toContain('<MODE:3>SSB');
    expect(tq8).toContain('20MN0CALL14.27SSB2026-04-1712:00:00Z');
    expect(tq8).not.toContain('<MODE:3>USB');
  });

  it('canonicalizes China province aliases in station fields and SIGNDATA', () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    const internals = provider as unknown as LoTWProviderInternals;
    vi.spyOn(internals, 'signLog').mockReturnValue('A'.repeat(88));

    const tq8 = internals.buildTq8Content(
      [createQso('china-ft8', {
        callsign: 'EA8UP',
        frequency: 21_076_450,
        mode: 'FT8',
        startTime: Date.parse('2026-05-02T08:21:45.000Z'),
      })],
      createStoredCertificate({
        dxccId: 318,
        certPem: '-----BEGIN CERTIFICATE-----\\nCERTDATA\\n-----END CERTIFICATE-----',
        privateKeyPem: 'key',
      }),
      {
        callsign: 'BG5DRB',
        dxccId: 318,
        gridSquare: 'PL09RX',
        cqZone: '24',
        ituZone: '44',
        iota: '',
        state: 'ZHEJIANG',
        county: '',
      },
    );

    expect(tq8).toContain('<CN_PROVINCE:2>ZJ');
    expect(tq8).not.toContain('ZHEJIANG');
    expect(tq8).toContain('ZJ24PL09RX4415MEA8UP21.07645FT82026-05-0208:21:45Z');
  });

  it('downloads valid LoTW ADIF even when field names contain invalid', async () => {
    const { ctx, addQSO, notifyUpdated } = createContext();
    ctx.fetch.mockResolvedValue(lotwResponse(
      'ARRL Logbook of the World Status Report\n'
      + '<PROGRAMID:4>LoTW <APP_LoTW_NUMREC:1>1 <eoh>\n'
      + '<CALL:6>N0CALL <BAND:3>20M <FREQ:8>14.07400 <MODE:3>FT8 '
      + '<QSO_DATE:8>20260420 <TIME_ON:6>054315 '
      + '<APP_LoTW_GRIDSQUARE_Invalid:6>KN87SC <eor>',
    ));

    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    const result = await provider.download('BG5DRB', {
      since: Date.parse('2026-03-27T00:00:00.000Z'),
      until: Date.parse('2026-03-27T23:59:59.999Z'),
    });

    expect(result.failures).toBeUndefined();
    expect(result.downloaded).toBe(1);
    expect(result.imported).toBe(1);
    expect(addQSO).toHaveBeenCalledTimes(1);
    expect(notifyUpdated).toHaveBeenCalledTimes(1);
  });

  it('download sync backfills sent and received status when a LoTW record matches a local QSO', async () => {
    const { ctx, queryQSOs, updateQSO, addQSO, notifyUpdated } = createContext();
    const local = createQso('local-1', {
      lotwQslSent: undefined,
      lotwQslSentDate: undefined,
      lotwQslReceived: undefined,
      lotwQslReceivedDate: undefined,
    });
    queryQSOs.mockResolvedValue([local]);
    ctx.fetch.mockResolvedValue(lotwResponse(
      'ARRL Logbook of the World Status Report\n<PROGRAMID:4>LoTW <eoh>\n'
      + '<CALL:6>N0CALL <STATION_CALLSIGN:6>BG5DRB <BAND:3>20M <FREQ:8>14.07400 '
      + '<MODE:4>MFSK <SUBMODE:3>FT8 <QSO_DATE:8>20260417 <TIME_ON:6>120000 '
      + '<LOTW_QSL_RCVD:1>Y <LOTW_QSLRDATE:8>20260418 <eor>',
    ));
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    const result = await provider.download('BG5DRB', {
      since: Date.parse('2026-04-17T00:00:00.000Z'),
      until: Date.parse('2026-04-17T23:59:59.999Z'),
    });

    expect(result).toMatchObject({ downloaded: 1, matched: 1, updated: 1, imported: 0 });
    expect(addQSO).not.toHaveBeenCalled();
    expect(updateQSO).toHaveBeenCalledWith('local-1', {
      lotwQslSent: 'Y',
      lotwQslSentDate: Date.parse('2026-04-18T00:00:00.000Z'),
      lotwQslReceived: 'Y',
      lotwQslReceivedDate: Date.parse('2026-04-18T00:00:00.000Z'),
    });
    expect(notifyUpdated).toHaveBeenCalledTimes(1);
  });

  it('downloads large LoTW ranges in dated request windows', async () => {
    const { ctx } = createContext();
    ctx.fetch.mockImplementation(async () => lotwResponse('ARRL Logbook of the World Status Report\n<eoh>\n'));
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    const result = await provider.download('BG5DRB', {
      since: Date.parse('2026-01-01T00:00:00.000Z'),
      until: Date.parse('2026-03-15T23:59:59.999Z'),
    });

    expect(result.windowCount).toBe(11);
    expect(ctx.fetch).toHaveBeenCalledTimes(11);
    const urls = ctx.fetch.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('qso_startdate=2026-01-01');
    expect(urls[0]).toContain('qso_enddate=2026-01-07');
    expect(urls[0]).toContain('qso_withown=yes');
    expect(urls[1]).toContain('qso_startdate=2026-01-08');
    expect(urls[1]).toContain('qso_enddate=2026-01-14');
    expect(urls[10]).toContain('qso_startdate=2026-03-12');
    expect(urls[10]).toContain('qso_enddate=2026-03-15');
  });

  it('keeps successful LoTW download windows when another window fails', async () => {
    const { ctx, addQSO } = createContext();
    ctx.fetch
      .mockResolvedValueOnce(lotwResponse(
        'ARRL Logbook of the World Status Report\n<PROGRAMID:4>LoTW <eoh>\n'
        + '<CALL:6>N0CALL <STATION_CALLSIGN:6>BG5DRB <BAND:3>20M <FREQ:8>14.07400 '
        + '<MODE:3>FT8 <QSO_DATE:8>20260101 <TIME_ON:6>120000 <eor>',
      ))
      .mockImplementation(async () => new Response('<html><b>Page Request Limit!</b></html>', { status: 503 }));
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    const result = await provider.download('BG5DRB', {
      since: Date.parse('2026-01-01T00:00:00.000Z'),
      until: Date.parse('2026-01-08T23:59:59.999Z'),
    });

    expect(result.downloaded).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'lotw_rate_limited',
        detail: expect.stringContaining('range=2026-01-08..2026-01-08'),
        retryable: true,
      }),
    ]);
    expect(addQSO).toHaveBeenCalledTimes(1);
  });

  it('retries a LoTW page request limit on the same window before moving on', async () => {
    const { ctx } = createContext();
    ctx.fetch
      .mockResolvedValueOnce(new Response('<html><b>Page Request Limit!</b></html>', { status: 503 }))
      .mockResolvedValueOnce(new Response('<html><b>Page Request Limit!</b></html>', { status: 503 }))
      .mockImplementation(async () => lotwResponse('ARRL Logbook of the World Status Report\n<eoh>\n'));
    const progress: Array<{ stage: string; windowIndex?: number; range?: string }> = [];
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    const result = await provider.download('BG5DRB', {
      since: Date.parse('2026-01-01T00:00:00.000Z'),
      until: Date.parse('2026-01-08T23:59:59.999Z'),
      onProgress: (next) => progress.push(next),
    });

    expect(result.failures).toBeUndefined();
    const urls = ctx.fetch.mock.calls.map(([url]) => String(url));
    expect(urls.slice(0, 3).every((url) => (
      url.includes('qso_startdate=2026-01-01') && url.includes('qso_enddate=2026-01-07')
    ))).toBe(true);
    expect(urls[3]).toContain('qso_startdate=2026-01-08');
    expect(progress.map((item) => item.stage)).toContain('window_retrying');
  });

  it('splits retryable timeout windows and adds time bounds for single-day chunks', async () => {
    const { ctx } = createContext();
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' });
    ctx.fetch
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockImplementation(async () => lotwResponse('ARRL Logbook of the World Status Report\n<eoh>\n'));
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    const result = await provider.download('BG5DRB', {
      since: Date.parse('2026-01-01T00:00:00.000Z'),
      until: Date.parse('2026-01-01T23:59:59.999Z'),
    });

    expect(result.failures).toBeUndefined();
    expect(result.windowCount).toBe(4);
    const urls = ctx.fetch.mock.calls.map(([url]) => String(url));
    expect(urls[3]).toContain('qso_starttime=000000');
    expect(urls[3]).toContain('qso_endtime=055959');
    expect(urls[4]).toContain('qso_starttime=060000');
    expect(urls[4]).toContain('qso_endtime=115959');
  });

  it('reports LoTW auth failure only for explicit credential errors', async () => {
    const { ctx } = createContext();
    ctx.fetch.mockImplementation(async () => lotwResponse('Login failed: incorrect password'));

    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    await expect(provider.testConnection('BG5DRB')).resolves.toEqual({
      success: false,
      message: 'Login failed: incorrect password',
      failures: [
        expect.objectContaining({
          code: 'lotw_auth_failed',
          message: 'Login failed: incorrect password',
        }),
      ],
    });
    await expect(provider.download('BG5DRB', {
      since: Date.parse('2026-04-17T00:00:00.000Z'),
      until: Date.parse('2026-04-17T23:59:59.999Z'),
    })).resolves.toMatchObject({
      failures: [
        expect.objectContaining({
          code: 'lotw_auth_failed',
          message: expect.stringContaining('incorrect password'),
        }),
      ],
    });
  });

  it('reports invalid LoTW response when the response is not ADIF or an auth failure', async () => {
    const { ctx } = createContext();
    ctx.fetch.mockImplementation(async () => lotwResponse('LoTW service is temporarily unavailable'));

    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    await expect(provider.testConnection('BG5DRB')).resolves.toEqual({
      success: false,
      message: 'LoTW service is temporarily unavailable',
      failures: [
        expect.objectContaining({
          code: 'lotw_response_invalid',
          message: 'LoTW service is temporarily unavailable',
        }),
      ],
    });
    await expect(provider.download('BG5DRB', {
      since: Date.parse('2026-04-17T00:00:00.000Z'),
      until: Date.parse('2026-04-17T23:59:59.999Z'),
    })).resolves.toMatchObject({
      failures: [
        expect.objectContaining({
          code: 'lotw_response_invalid',
          message: expect.stringContaining('LoTW service is temporarily unavailable'),
        }),
      ],
    });
  });

  it('returns structured failure when LoTW upload is not configured', async () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);

    const result = await provider.upload('BG5DRB', {
      trigger: 'auto',
      records: [createQso('qso-1')],
    });

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'lotw_not_configured',
        message: 'LoTW not configured',
        providerId: 'lotw',
      }),
    ]);
  });

  it('surfaces LoTW upload rejection details as structured failures', async () => {
    const { ctx, queryQSOs } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);
    const qso = createQso('qso-1');
    queryQSOs.mockResolvedValue([qso]);
    const internals = provider as unknown as LoTWProviderInternals;
    vi.spyOn(internals, 'prepareUpload').mockResolvedValue({
      issues: [],
      blockedCount: 0,
      batches: [
        {
          qsos: [qso],
          certificate: { callsign: 'BG5DRB' },
        },
      ],
    });
    vi.spyOn(internals, 'resolveUploadLocation').mockReturnValue({ callsign: 'BG5DRB', dxccId: 291, gridSquare: 'PM01AA', cqZone: '24', ituZone: '44', state: 'CA', county: 'Santa Clara' });
    vi.spyOn(internals, 'uploadBatch').mockRejectedValue(new Error('LoTW server rejected the upload payload: invalid signature'));

    const result = await provider.upload('BG5DRB');

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'lotw_upload_rejected',
        message: expect.stringContaining('invalid signature'),
        qsoCallsign: 'BG5DRB',
      }),
    ]);
  });
});
