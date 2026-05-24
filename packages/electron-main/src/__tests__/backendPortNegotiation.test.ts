import { describe, expect, it, vi } from 'vitest';

import {
  BackendPortExhaustedError,
  ServerReadyHealthProbeError,
  findAvailableBackendPort,
  waitForServerReadyWithProbe,
  type ServerReadyState,
  type Tx5drProbeResult,
} from '../backendPortNegotiation.js';

function probeResult(overrides: Partial<Tx5drProbeResult> = {}): Tx5drProbeResult {
  return {
    ok: false,
    url: 'http://127.0.0.1:4000/',
    statusCode: null,
    bodyPreview: null,
    errorCode: 'ECONNREFUSED',
    errorMessage: 'connect ECONNREFUSED',
    timedOut: false,
    ...overrides,
  };
}

function ready(port: number): ServerReadyState {
  return {
    pid: 1234,
    timestamp: new Date().toISOString(),
    requestedPort: 4000,
    httpPort: port,
    baseUrl: `http://127.0.0.1:${port}`,
    healthOk: true,
    autoPort: true,
    error: null,
  };
}

describe('backend port negotiation', () => {
  it('skips an occupied backend port and selects the next bindable port', async () => {
    const bindCheck = vi.fn(async (port: number) => port !== 4000);
    const probe = vi.fn(async (baseUrl: string) => probeResult({
      url: `${baseUrl}/`,
      statusCode: 200,
      bodyPreview: '<html>other service</html>',
      errorCode: 'INVALID_JSON',
    }));

    await expect(findAvailableBackendPort({
      startPort: 4000,
      scanSteps: 2,
      bindCheck,
      probe,
    })).resolves.toMatchObject({
      port: 4001,
      diagnostics: [{ port: 4000, bindOk: false }],
    });

    expect(bindCheck).toHaveBeenCalledWith(4000, '0.0.0.0');
    expect(bindCheck).toHaveBeenCalledWith(4001, '0.0.0.0');
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:4000');
  });

  it('reports exhausted backend port range when all candidates are occupied', async () => {
    const bindCheck = vi.fn(async () => false);
    const probe = vi.fn(async (baseUrl: string) => probeResult({ url: `${baseUrl}/`, timedOut: true, errorCode: 'ETIMEDOUT' }));

    await expect(findAvailableBackendPort({
      startPort: 4000,
      scanSteps: 1,
      bindCheck,
      probe,
    })).rejects.toBeInstanceOf(BackendPortExhaustedError);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('accepts the actual negotiated port from server-ready when health matches', async () => {
    const negotiated = ready(4002);

    await expect(waitForServerReadyWithProbe({
      readyFile: 'server-ready.json',
      readReadyFile: () => negotiated,
      timeoutMs: 100,
      intervalMs: 1,
      probe: vi.fn(async () => probeResult({
        ok: true,
        url: 'http://127.0.0.1:4002/',
        statusCode: 200,
        bodyPreview: '{"status":"ok","service":"TX-5DR Server"}',
        errorCode: null,
        errorMessage: null,
      })),
    })).resolves.toBe(negotiated);
  });

  it('fails fast when a ready backend keeps failing health probes', async () => {
    const staleReady = ready(4000);

    await expect(waitForServerReadyWithProbe({
      readyFile: 'server-ready.json',
      readReadyFile: () => staleReady,
      timeoutMs: 100,
      intervalMs: 1,
      healthFailureTimeoutMs: 5,
      probe: vi.fn(async () => probeResult({ timedOut: true, errorCode: 'ETIMEDOUT' })),
    })).rejects.toBeInstanceOf(ServerReadyHealthProbeError);
  });
});
