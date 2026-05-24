import http from 'node:http';
import net from 'node:net';

export interface ServerReadyState {
  pid?: number;
  timestamp?: string;
  requestedPort?: number;
  httpPort: number | null;
  baseUrl: string | null;
  healthOk: boolean;
  autoPort?: boolean;
  error?: {
    code?: string | null;
    message?: string;
    attemptedPort?: number;
    startPort?: number;
    endPort?: number;
  } | null;
}

export interface Tx5drProbeResult {
  ok: boolean;
  url: string;
  statusCode: number | null;
  bodyPreview: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  timedOut: boolean;
}

export interface BackendPortDiagnostic {
  port: number;
  bindOk: boolean;
  probe: Tx5drProbeResult | null;
}

export interface BackendPortSelection {
  port: number;
  diagnostics: BackendPortDiagnostic[];
}

export interface BackendPortLogger {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
}

export class BackendPortExhaustedError extends Error {
  constructor(
    public readonly startPort: number,
    public readonly endPort: number,
    public readonly diagnostics: BackendPortDiagnostic[],
  ) {
    super(`No available backend port found from ${startPort} to ${endPort}`);
    this.name = 'BackendPortExhaustedError';
  }
}

export class ServerReadyFileError extends Error {
  constructor(
    public readonly readyFile: string,
    public readonly ready: ServerReadyState,
  ) {
    super(`server_ready_error:${JSON.stringify(ready.error ?? {})}`);
    this.name = 'ServerReadyFileError';
  }
}

export class ServerReadyHealthProbeError extends Error {
  constructor(
    public readonly readyFile: string,
    public readonly ready: ServerReadyState,
    public readonly probe: Tx5drProbeResult,
  ) {
    super(`server_ready_health_probe_failed:${JSON.stringify({
      readyFile,
      baseUrl: ready.baseUrl,
      httpPort: ready.httpPort,
      probe,
    })}`);
    this.name = 'ServerReadyHealthProbeError';
  }
}

export class ServerReadyTimeoutError extends Error {
  constructor(
    public readonly readyFile: string,
    public readonly timeoutMs: number,
    public readonly lastReady: ServerReadyState | null,
    public readonly lastProbe: Tx5drProbeResult | null,
  ) {
    super(`server_ready_timeout:${JSON.stringify({
      readyFile,
      timeoutMs,
      lastReady,
      lastProbe,
    })}`);
    this.name = 'ServerReadyTimeoutError';
  }
}

export async function probeTx5drServer(baseUrl: string, timeoutMs = 2000): Promise<Tx5drProbeResult> {
  const url = new URL('/', baseUrl).toString();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Tx5drProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: Number(parsed.port || 80),
        path: parsed.pathname || '/',
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 4096) {
            req.destroy();
          }
        });
        res.on('end', () => {
          const bodyPreview = data.slice(0, 512);
          try {
            const body = JSON.parse(data) as { status?: string; service?: string };
            const ok = res.statusCode === 200 && body.status === 'ok' && body.service === 'TX-5DR Server';
            finish({
              ok,
              url,
              statusCode: res.statusCode ?? null,
              bodyPreview,
              errorCode: ok ? null : 'UNEXPECTED_RESPONSE',
              errorMessage: ok ? null : 'Response did not match TX-5DR health identity',
              timedOut: false,
            });
          } catch (error) {
            finish({
              ok: false,
              url,
              statusCode: res.statusCode ?? null,
              bodyPreview,
              errorCode: 'INVALID_JSON',
              errorMessage: error instanceof Error ? error.message : String(error),
              timedOut: false,
            });
          }
        });
      });

      req.on('error', (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          url,
          statusCode: null,
          bodyPreview: null,
          errorCode: error.code ?? 'REQUEST_ERROR',
          errorMessage: error.message,
          timedOut: false,
        });
      });
      req.on('timeout', () => {
        req.destroy();
        finish({
          ok: false,
          url,
          statusCode: null,
          bodyPreview: null,
          errorCode: 'ETIMEDOUT',
          errorMessage: `Health probe timed out after ${timeoutMs}ms`,
          timedOut: true,
        });
      });
      req.end();
    } catch (error) {
      finish({
        ok: false,
        url,
        statusCode: null,
        bodyPreview: null,
        errorCode: 'PROBE_SETUP_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
    }
  });
}

export function canBindPort(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

export async function findAvailableBackendPort(options: {
  startPort: number;
  scanSteps: number;
  host?: string;
  avoidPorts?: ReadonlySet<number>;
  bindCheck?: (port: number, host: string) => Promise<boolean>;
  probe?: (baseUrl: string) => Promise<Tx5drProbeResult>;
  logger?: BackendPortLogger;
}): Promise<BackendPortSelection> {
  const host = options.host ?? '0.0.0.0';
  const bindCheck = options.bindCheck ?? canBindPort;
  const probe = options.probe ?? ((baseUrl: string) => probeTx5drServer(baseUrl, 1000));
  const diagnostics: BackendPortDiagnostic[] = [];

  for (let step = 0; step <= options.scanSteps; step += 1) {
    const port = options.startPort + step;
    if (options.avoidPorts?.has(port)) {
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const bindOk = await bindCheck(port, host);
    if (bindOk) {
      options.logger?.info?.('backend port selected', { port, host });
      return { port, diagnostics };
    }

    // eslint-disable-next-line no-await-in-loop
    const probeResult = await probe(`http://127.0.0.1:${port}`);
    const diagnostic = { port, bindOk, probe: probeResult };
    diagnostics.push(diagnostic);
    options.logger?.warn?.('backend port preflight skipped occupied port', {
      port,
      host,
      probe: summarizeProbeResult(probeResult),
    });
  }

  throw new BackendPortExhaustedError(options.startPort, options.startPort + options.scanSteps, diagnostics);
}

export function summarizeProbeResult(probe: Tx5drProbeResult | null): string {
  if (!probe) return 'not probed';
  if (probe.ok) return 'existing TX-5DR health endpoint responded';
  const parts = [
    probe.errorCode ?? 'UNKNOWN',
    probe.statusCode ? `status=${probe.statusCode}` : null,
    probe.timedOut ? 'timedOut=true' : null,
    probe.bodyPreview ? `body=${probe.bodyPreview.slice(0, 120)}` : null,
  ].filter(Boolean);
  return parts.join(' ') || 'probe failed';
}

export async function waitForServerReadyWithProbe(options: {
  readyFile: string;
  readReadyFile: () => ServerReadyState | null;
  timeoutMs: number;
  intervalMs: number;
  probe?: (baseUrl: string) => Promise<Tx5drProbeResult>;
  healthFailureTimeoutMs?: number;
  logger?: BackendPortLogger;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ServerReadyState> {
  const started = Date.now();
  const probe = options.probe ?? probeTx5drServer;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastReady: ServerReadyState | null = null;
  let lastProbe: Tx5drProbeResult | null = null;
  let firstHealthFailureAt: number | null = null;

  while (Date.now() - started <= options.timeoutMs) {
    const ready = options.readReadyFile();
    if (ready) {
      lastReady = ready;
      if (ready.error) {
        throw new ServerReadyFileError(options.readyFile, ready);
      }
      if (Number.isInteger(ready.httpPort) && Number(ready.httpPort) > 0 && Number(ready.httpPort) < 65536 && ready.baseUrl && ready.healthOk) {
        // eslint-disable-next-line no-await-in-loop
        const probeResult = await probe(ready.baseUrl);
        if (probeResult.ok) {
          return ready;
        }
        lastProbe = probeResult;
        firstHealthFailureAt ??= Date.now();
        options.logger?.warn?.('backend health probe failed', {
          readyFile: options.readyFile,
          baseUrl: ready.baseUrl,
          httpPort: ready.httpPort,
          probe: summarizeProbeResult(probeResult),
        });
        if (
          options.healthFailureTimeoutMs !== undefined
          && Date.now() - firstHealthFailureAt >= options.healthFailureTimeoutMs
        ) {
          throw new ServerReadyHealthProbeError(options.readyFile, ready, probeResult);
        }
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(options.intervalMs);
  }

  throw new ServerReadyTimeoutError(options.readyFile, options.timeoutMs, lastReady, lastProbe);
}

export function isRetryableBackendReadyError(error: unknown): error is ServerReadyHealthProbeError | ServerReadyFileError {
  return error instanceof ServerReadyHealthProbeError
    || (error instanceof ServerReadyFileError && error.ready.error?.code === 'EADDRINUSE');
}

export function getReadyErrorPort(error: ServerReadyHealthProbeError | ServerReadyFileError): number | null {
  if (error.ready.httpPort) return error.ready.httpPort;
  return error.ready.error?.attemptedPort ?? null;
}
