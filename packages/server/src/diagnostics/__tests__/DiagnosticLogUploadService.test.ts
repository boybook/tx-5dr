import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSensitiveLogValue } from '../../utils/sensitive-log.js';
import {
  DiagnosticLogUploadService,
  DiagnosticUploadError,
} from '../DiagnosticLogUploadService.js';

const roots: string[] = [];
const fromMs = Date.parse('2026-08-21T00:00:00.000Z');
const toMs = Date.parse('2026-08-21T01:00:00.000Z');

async function createDirectories() {
  const root = await mkdtemp(join(tmpdir(), 'tx5dr-diagnostic-test-'));
  roots.push(root);
  const logs = join(root, 'logs');
  const temporary = join(root, 'temporary');
  await mkdir(logs);
  await mkdir(temporary);
  return { root, logs, temporary };
}

const gatewayContext = {
  endpoint: 'https://gateway.example.invalid',
  installationId: 'ccf53abe-a5c7-4bb0-bcaf-5e1b9fbc2da4',
  app: {
    version: '1.2.3',
    build_channel: 'release' as const,
    build_commit: 'abcdef0',
    distribution: 'electron' as const,
    os_family: 'darwin' as const,
    arch: 'arm64' as const,
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }));
  vi.restoreAllMocks();
});

describe('DiagnosticLogUploadService', () => {
  it('lists only supported regular log files', async () => {
    const { logs, temporary } = await createDirectories();
    await writeFile(join(logs, 'tx5dr-server.log'), '[2026-08-21T00:30:00.000Z] server\n');
    await writeFile(join(logs, 'tx5dr-server_20260821T000000.log'), '[2026-08-21T00:00:00.000Z] rotated\n');
    await writeFile(join(logs, 'arbitrary.log'), '[2026-08-21T00:10:00.000Z] must not appear\n');

    const service = new DiagnosticLogUploadService({
      getLogsDir: async () => logs,
      getGatewayContext: async () => gatewayContext,
      temporaryRoot: temporary,
    });
    const result = await service.listSources();

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: 'server', fileName: 'tx5dr-server.log', fileCount: 2 });
    expect(result.sources[0].availableFromMs).toBe(fromMs);
    expect(result.sources[0].availableToMs).toBe(Date.parse('2026-08-21T00:30:00.000Z'));
  });

  it('merges rotated logs by timestamp, keeps stack lines, redacts again, and cleans the 0600 temp file', async () => {
    const { logs, temporary } = await createDirectories();
    const registeredSecret = 'registered-secret-value';
    registerSensitiveLogValue(registeredSecret);
    await writeFile(join(logs, 'tx5dr-server_20260821T000000.log'), [
      '[2026-08-21T00:10:00.000Z] ERROR token=visible-token',
      '    at oldStack (old.js:1:1)',
      '[2026-08-21T02:00:00.000Z] outside',
    ].join('\n'));
    await writeFile(join(logs, 'tx5dr-server.log'), [
      '[2026-08-21T00:40:00.000Z] ERROR path=/tmp/radio authorization: Bearer bearer-token',
      `    context=${registeredSecret}`,
    ].join('\n'));

    let uploadedLog = '';
    let uploadPayload: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (url: string | URL, options?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/v1/diagnostics/authorize')) {
        return Response.json({ diagnostics_token: 'diagnostic-token' }, { status: 201 });
      }
      if (value.endsWith('/v1/diagnostics/uploads')) {
        uploadPayload = JSON.parse(String(options?.body));
        return Response.json({
          upload_url: 'https://private-oss.example.invalid/',
          form_fields: { key: 'diagnostics/v1/test.log.gz', policy: 'policy' },
          upload_receipt: 'signed-receipt',
        }, { status: 201 });
      }
      if (value === 'https://private-oss.example.invalid/') {
        const temporaryEntries = await readdir(temporary);
        expect(temporaryEntries).toHaveLength(1);
        const files = await readdir(join(temporary, temporaryEntries[0]));
        expect(files).toHaveLength(1);
        expect((await stat(join(temporary, temporaryEntries[0], files[0]))).mode & 0o777).toBe(0o600);
        const file = (options?.body as FormData).get('file') as Blob;
        uploadedLog = gunzipSync(Buffer.from(await file.arrayBuffer())).toString('utf8');
        return new Response(null, { status: 204 });
      }
      if (value.includes('/complete')) {
        return Response.json({
          accepted_at: '2026-08-21T01:00:01.000Z',
          retained_until: '2026-09-20T01:00:01.000Z',
        }, { status: 202 });
      }
      throw new Error(`Unexpected URL ${value}`);
    });

    const service = new DiagnosticLogUploadService({
      getLogsDir: async () => logs,
      getGatewayContext: async () => gatewayContext,
      fetch: fetchMock as typeof fetch,
      temporaryRoot: temporary,
    });
    const result = await service.upload({ sourceId: 'server', fromMs, toMs, feedback: '  radio stopped  ' });

    expect(result).toMatchObject({ sourceId: 'server', lineCount: 4, includedFromMs: Date.parse('2026-08-21T00:10:00.000Z') });
    expect(uploadedLog.indexOf('oldStack')).toBeLessThan(uploadedLog.indexOf('path=/tmp/radio'));
    expect(uploadedLog).toContain('token=<redacted>');
    expect(uploadedLog).not.toContain('bearer-token');
    expect(uploadedLog).toContain('context=<redacted>');
    expect(uploadedLog).toContain('path=/tmp/radio');
    expect(uploadPayload).toMatchObject({ source_id: 'server', line_count: 4, is_test: false });
    const completeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/complete'));
    expect(JSON.parse(String(completeCall?.[1]?.body))).toMatchObject({ feedback: 'radio stopped' });
    expect(await readdir(temporary)).toEqual([]);
  });

  it('enforces configurable raw and gzip limits', async () => {
    const { logs, temporary } = await createDirectories();
    await writeFile(join(logs, 'tx5dr-server.log'), `[2026-08-21T00:10:00.000Z] ${'x'.repeat(300)}\n`);

    const rawLimited = new DiagnosticLogUploadService({
      getLogsDir: async () => logs,
      getGatewayContext: async () => gatewayContext,
      temporaryRoot: temporary,
      maxUncompressedBytes: 100,
    });
    await expect(rawLimited.upload({ sourceId: 'server', fromMs, toMs }))
      .rejects.toMatchObject({ code: 'DIAGNOSTIC_RANGE_TOO_LARGE' });

    const gzipLimited = new DiagnosticLogUploadService({
      getLogsDir: async () => logs,
      getGatewayContext: async () => gatewayContext,
      temporaryRoot: temporary,
      maxCompressedBytes: 10,
    });
    await expect(gzipLimited.upload({ sourceId: 'server', fromMs, toMs }))
      .rejects.toMatchObject({ code: 'DIAGNOSTIC_RANGE_TOO_LARGE' });
  });

  it('removes temporary files when the gateway is unavailable', async () => {
    const { logs, temporary } = await createDirectories();
    await writeFile(join(logs, 'tx5dr-server.log'), '[2026-08-21T00:10:00.000Z] failure path\n');
    const service = new DiagnosticLogUploadService({
      getLogsDir: async () => logs,
      getGatewayContext: async () => gatewayContext,
      fetch: vi.fn(async () => { throw new Error('offline'); }) as typeof fetch,
      temporaryRoot: temporary,
    });

    await expect(service.upload({ sourceId: 'server', fromMs, toMs }))
      .rejects.toBeInstanceOf(DiagnosticUploadError);
    expect(await readdir(temporary)).toEqual([]);
  });
});
