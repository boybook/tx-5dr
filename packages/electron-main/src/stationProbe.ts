import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {
  DESKTOP_BRIDGE_VERSION,
  STATION_IDENTITY_VERSION,
  StationIdentitySchema,
  type StationIdentity,
} from '@tx5dr/contracts';

/**
 * Checks a station before the shell hosts its UI.
 *
 * The shell depends only on `GET /api/station/identity`; a station without a
 * valid identity is refused rather than guessed at. HTTPS stations are trusted
 * through the system store or a pinned certificate fingerprint (trust on first
 * use, confirmed by the user). A changed pinned certificate is reported, never
 * silently accepted.
 */

export type StationTlsMode = { kind: 'system' } | { kind: 'pinned'; fingerprint256: string };

export interface ProbeHttpResponse {
  status: number;
  location?: string;
  body: string;
}

export interface CertificateSummary {
  fingerprint256: string;
  subject: string | null;
  issuer: string | null;
  validTo: string | null;
}

export interface StationProbeTransport {
  /** GET `<origin><path>`; rejects with an error carrying `code` (and `actual` for a pin mismatch). */
  get(origin: string, path: string, tlsMode: StationTlsMode): Promise<ProbeHttpResponse>;
  /** Reads the leaf certificate without trusting it. */
  inspectCertificate(origin: string): Promise<CertificateSummary>;
}

export type StationProbeResult =
  | { kind: 'ok'; identity: StationIdentity; tls: 'none' | 'system' | 'pinned' }
  | { kind: 'certificate-untrusted'; certificate: CertificateSummary; reason: string }
  | { kind: 'certificate-changed'; expected: string; actual: string | null }
  | { kind: 'not-a-station'; status: number | null }
  | { kind: 'bridge-too-old'; identity: StationIdentity; required: number }
  | { kind: 'redirect'; location: string }
  | { kind: 'unreachable'; code: string };

export const IDENTITY_PATH = '/api/station/identity';

const CERTIFICATE_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'UNKNOWN';
}

export function isCertificateTrustError(error: unknown): boolean {
  return CERTIFICATE_ERROR_CODES.has(errorCode(error));
}

export async function probeStation(
  origin: string,
  options: { pinnedFingerprint256?: string | null; transport?: StationProbeTransport } = {},
): Promise<StationProbeResult> {
  const transport = options.transport ?? nodeProbeTransport;
  const secure = origin.startsWith('https:');
  const pinned = secure && options.pinnedFingerprint256 ? options.pinnedFingerprint256 : null;
  const tlsMode: StationTlsMode = pinned ? { kind: 'pinned', fingerprint256: pinned } : { kind: 'system' };

  let response: ProbeHttpResponse;
  try {
    response = await transport.get(origin, IDENTITY_PATH, tlsMode);
  } catch (error) {
    if (errorCode(error) === 'UPSTREAM_CERT_MISMATCH' && pinned) {
      const actual = (error as { actual?: unknown }).actual;
      return { kind: 'certificate-changed', expected: pinned, actual: typeof actual === 'string' ? actual : null };
    }
    if (secure && !pinned && isCertificateTrustError(error)) {
      try {
        const certificate = await transport.inspectCertificate(origin);
        return { kind: 'certificate-untrusted', certificate, reason: errorCode(error) };
      } catch (inspectError) {
        return { kind: 'unreachable', code: errorCode(inspectError) };
      }
    }
    return { kind: 'unreachable', code: errorCode(error) };
  }

  if (response.status >= 300 && response.status < 400 && response.location) {
    return { kind: 'redirect', location: new URL(response.location, origin).href };
  }
  // A proxy in front of a stopped station answers 502/503/504.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return { kind: 'unreachable', code: `HTTP_${response.status}` };
  }
  if (response.status !== 200) return { kind: 'not-a-station', status: response.status };

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(response.body);
  } catch {
    return { kind: 'not-a-station', status: response.status };
  }
  const identity = StationIdentitySchema.safeParse(parsedBody);
  if (!identity.success || identity.data.identityVersion !== STATION_IDENTITY_VERSION) {
    return { kind: 'not-a-station', status: response.status };
  }
  if (identity.data.desktopBridge.minVersion > DESKTOP_BRIDGE_VERSION) {
    return { kind: 'bridge-too-old', identity: identity.data, required: identity.data.desktopBridge.minVersion };
  }
  return { kind: 'ok', identity: identity.data, tls: !secure ? 'none' : pinned ? 'pinned' : 'system' };
}

// ===== Node transport =====

const PROBE_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 64 * 1024;

function normalizeFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 64 ? hex.match(/.{2}/g)!.join(':') : null;
}

function targetOf(origin: string) {
  const url = new URL(origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return {
    url,
    hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    servername: net.isIP(hostname) ? undefined : hostname,
  };
}

/** Agent whose sockets are handed to the request only after the pinned fingerprint matched. */
class PinnedAgent extends http.Agent {
  constructor(private readonly origin: string, private readonly fingerprint256: string) {
    super({ keepAlive: false });
  }

  createConnection(_options: unknown, callback: (error: Error | null, socket?: net.Socket) => void): undefined {
    const target = targetOf(this.origin);
    const expected = normalizeFingerprint(this.fingerprint256);
    let settled = false;
    const finish = (error: Error | null, socket?: net.Socket) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    const socket = tls.connect({
      host: target.hostname,
      port: target.port,
      servername: target.servername,
      rejectUnauthorized: false,
    }, () => {
      const actual = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
      if (!expected || actual !== expected) {
        socket.destroy();
        finish(Object.assign(new Error('certificate fingerprint mismatch'), { code: 'UPSTREAM_CERT_MISMATCH', actual }));
        return;
      }
      finish(null, socket);
    });
    socket.once('error', error => finish(error));
    return undefined;
  }
}

function formatCertificateName(name: tls.PeerCertificate['subject'] | undefined): string | null {
  if (!name) return null;
  const parts = Object.entries(name).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`);
  return parts.length ? parts.join(', ') : null;
}

export const nodeProbeTransport: StationProbeTransport = {
  get(origin, path, tlsMode) {
    const target = targetOf(origin);
    const secure = target.url.protocol === 'https:';
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions & https.RequestOptions = {
        host: target.hostname,
        port: target.port,
        path,
        method: 'GET',
        agent: false,
        timeout: PROBE_TIMEOUT_MS,
        headers: { host: target.url.host, accept: 'application/json' },
      };
      let request: http.ClientRequest;
      if (secure && tlsMode.kind === 'pinned') {
        request = http.request({ ...options, agent: new PinnedAgent(origin, tlsMode.fingerprint256) });
      } else if (secure) {
        request = https.request({ ...options, servername: target.servername, rejectUnauthorized: true });
      } else {
        request = http.request(options);
      }
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy(Object.assign(new Error('identity response too large'), { code: 'RESPONSE_TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          location: typeof response.headers.location === 'string' ? response.headers.location : undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT' })));
      request.on('error', reject);
      request.end();
    });
  },

  inspectCertificate(origin) {
    const target = targetOf(origin);
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: target.hostname,
        port: target.port,
        servername: target.servername,
        rejectUnauthorized: false,
        timeout: PROBE_TIMEOUT_MS,
      }, () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        const fingerprint256 = normalizeFingerprint(certificate?.fingerprint256);
        if (!fingerprint256) {
          reject(Object.assign(new Error('no peer certificate'), { code: 'NO_PEER_CERTIFICATE' }));
          return;
        }
        resolve({
          fingerprint256,
          subject: formatCertificateName(certificate.subject),
          issuer: formatCertificateName(certificate.issuer),
          validTo: certificate.valid_to ?? null,
        });
      });
      socket.on('timeout', () => socket.destroy(Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT' })));
      socket.once('error', reject);
    });
  },
};
