import { describe, expect, it, vi } from 'vitest';
import { constants, createHash, generateKeyPairSync, publicDecrypt } from 'crypto';

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
  const files = new Map<string, Buffer>();
  const queryQSOs = vi.fn(async (_filter?: unknown) => [] as QSORecord[]);
  const updateQSO = vi.fn(async () => undefined);
  const addQSO = vi.fn(async () => undefined);
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
    } as any,
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
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const signData = '20MN0CALL14.074FT82026-04-1712:00:00Z';

    const signature = Buffer.from(
      (provider as any).signLog(
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
    await expect(provider.deleteCertificate('BG5DRB', certificates[0].id)).resolves.toBe(true);
    expect(files.has(filePath)).toBe(false);
    expect(ctx.files.delete).toHaveBeenCalledWith(filePath);
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

  it('projects SSB sideband records to LoTW contact mode SSB', () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    vi.spyOn(provider as any, 'signLog').mockReturnValue('A'.repeat(88));

    const tq8 = (provider as any).buildTq8Content(
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
    ) as string;

    expect(tq8).toContain('<MODE:3>SSB');
    expect(tq8).toContain('<SIGNDATA:');
    expect(tq8).toContain('20MN0CALL14.27SSB2026-04-1712:00:00Z');
    expect(tq8).not.toContain('<MODE:3>USB');
    expect(tq8).not.toContain('14.27USB');
  });

  it('projects legacy USB records to LoTW contact mode SSB', () => {
    const { ctx } = createContext();
    const provider = new LoTWSyncProvider(ctx);
    vi.spyOn(provider as any, 'signLog').mockReturnValue('A'.repeat(88));

    const tq8 = (provider as any).buildTq8Content(
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
    ) as string;

    expect(tq8).toContain('<MODE:3>SSB');
    expect(tq8).toContain('20MN0CALL14.27SSB2026-04-1712:00:00Z');
    expect(tq8).not.toContain('<MODE:3>USB');
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
    });

    expect(result.errors).toBeUndefined();
    expect(result.downloaded).toBe(1);
    expect(result.updated).toBe(1);
    expect(addQSO).toHaveBeenCalledTimes(1);
    expect(notifyUpdated).toHaveBeenCalledTimes(1);
  });

  it('reports LoTW auth failure only for explicit credential errors', async () => {
    const { ctx } = createContext();
    ctx.fetch.mockImplementation(async () => lotwResponse('Login failed: incorrect password'));

    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    await expect(provider.testConnection('BG5DRB')).resolves.toEqual({
      success: false,
      message: 'lotw_auth_failed',
    });
    await expect(provider.download('BG5DRB')).resolves.toMatchObject({
      errors: ['lotw_auth_failed'],
    });
  });

  it('reports invalid LoTW response when the response is not ADIF or an auth failure', async () => {
    const { ctx } = createContext();
    ctx.fetch.mockImplementation(async () => lotwResponse('LoTW service is temporarily unavailable'));

    const provider = new LoTWSyncProvider(ctx);
    configureProvider(provider);

    await expect(provider.testConnection('BG5DRB')).resolves.toEqual({
      success: false,
      message: 'lotw_response_invalid',
    });
    await expect(provider.download('BG5DRB')).resolves.toMatchObject({
      errors: ['lotw_response_invalid'],
    });
  });
});
