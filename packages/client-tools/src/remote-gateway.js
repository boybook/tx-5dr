// Loopback gateway from the desktop shell to a remote TX-5DR station.
//
// The shell loads the remote station's own Web UI through this gateway so the
// page origin stays http://127.0.0.1:<port> (a secure context with a stable
// origin per station) while every request goes to the remote station.
//
// Invariants:
// - Listens on loopback only. Requests must carry a loopback Host for the
//   gateway's own port (DNS-rebinding guard) and, when present, the gateway's own
//   Origin; WebSocket upgrades must carry it. Other local pages cannot use the
//   gateway to reach the station.
// - Origin, Referer and forwarding headers are not passed upstream: the gateway
//   is the user's own client, and the station still requires its normal
//   authentication. Station policy is not relaxed.
// - HTTPS upstreams are verified with system trust, or, when a fingerprint is
//   pinned, against that SHA-256 certificate fingerprint before any request byte
//   is written.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackHostname, parseHostHeader } from './gateway-utils.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const NOT_FORWARDED = new Set([
  'host',
  'origin',
  'referer',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);

const OFFLINE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);

export function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 64) return null;
  return hex.match(/.{2}/g).join(':');
}

function parseTarget(rawTarget) {
  const url = new URL(rawTarget);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported target protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('target must not contain credentials');
  return {
    url,
    origin: url.origin,
    secure: url.protocol === 'https:',
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    host: url.host,
  };
}

/** Error raised when a pinned upstream presents another certificate. */
export class UpstreamCertificateMismatchError extends Error {
  constructor(expected, actual) {
    super('upstream certificate fingerprint mismatch');
    this.name = 'UpstreamCertificateMismatchError';
    this.code = 'UPSTREAM_CERT_MISMATCH';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Opens a verified socket to the target. The callback receives the socket only
 * after the TLS identity check succeeded, so no request data reaches an
 * unverified peer.
 */
function connectUpstream(target, pinnedFingerprint, callback) {
  let settled = false;
  const finish = (error, socket) => {
    if (settled) return;
    settled = true;
    callback(error, socket);
  };

  if (!target.secure) {
    const socket = net.connect(target.port, target.hostname, () => finish(null, socket));
    socket.once('error', error => finish(error));
    return socket;
  }

  const servername = net.isIP(target.hostname) ? undefined : target.hostname;
  const socket = tls.connect({
    host: target.hostname,
    port: target.port,
    servername,
    rejectUnauthorized: !pinnedFingerprint,
  }, () => {
    if (pinnedFingerprint) {
      const actual = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
      if (actual !== pinnedFingerprint) {
        const error = new UpstreamCertificateMismatchError(pinnedFingerprint, actual);
        socket.destroy(error);
        finish(error);
        return;
      }
    }
    finish(null, socket);
  });
  socket.once('error', error => finish(error));
  return socket;
}

class UpstreamAgent extends http.Agent {
  constructor(target, pinnedFingerprint) {
    super({ keepAlive: true, maxSockets: 32 });
    this.target = target;
    this.pinnedFingerprint = pinnedFingerprint;
  }

  createConnection(_options, oncreate) {
    connectUpstream(this.target, this.pinnedFingerprint, oncreate);
    // The socket is delivered through oncreate after verification.
    return undefined;
  }
}

function buildUpstreamHeaders(reqHeaders, target) {
  const headers = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || NOT_FORWARDED.has(key) || value === undefined) continue;
    headers[key] = value;
  }
  headers.host = target.host;
  return headers;
}

/**
 * Rewrites a redirect that stays on the station to a gateway-relative path.
 * Returns null for a redirect to any other origin, which the gateway refuses
 * to follow inside the station window.
 */
export function rewriteLocation(location, target) {
  if (typeof location !== 'string' || location === '') return location;
  let resolved;
  try {
    resolved = new URL(location, target.url);
  } catch {
    return null;
  }
  if (resolved.origin !== target.origin) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function rejectSocket(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createRemoteGateway(options) {
  const target = parseTarget(options.target);
  const pinnedFingerprint = options.tlsFingerprint256 == null
    ? null
    : normalizeFingerprint(options.tlsFingerprint256);
  if (options.tlsFingerprint256 != null && !pinnedFingerprint) {
    throw new Error('invalid TLS fingerprint');
  }
  if (pinnedFingerprint && !target.secure) throw new Error('a TLS fingerprint requires an https target');
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHostname(host)) throw new Error('remote gateway must listen on a loopback address');
  const requestedPort = Number(options.port ?? 0);
  const logger = options.logger ?? console;
  const agent = new UpstreamAgent(target, pinnedFingerprint);
  let activePort = null;

  function ownOrigins() {
    return new Set([`http://127.0.0.1:${activePort}`, `http://localhost:${activePort}`]);
  }

  /** Returns a rejection reason, or null when the request comes from the gateway's own pages. */
  function checkEntry(req, { requireOrigin }) {
    const { hostname, port } = parseHostHeader(req.headers.host);
    if (!isLoopbackHostname(hostname) || Number(port) !== activePort) return 'host_not_allowed';
    const origin = req.headers.origin;
    if (origin === undefined) return requireOrigin ? 'origin_required' : null;
    return ownOrigins().has(String(origin)) ? null : 'origin_not_allowed';
  }

  function handleRequest(req, res) {
    const rejection = checkEntry(req, { requireOrigin: false });
    if (rejection) {
      logger.warn('[remote-gateway] request rejected', { reason: rejection, method: req.method, url: req.url });
      sendJson(res, 403, { success: false, code: 'GATEWAY_FORBIDDEN', reason: rejection });
      return;
    }

    const upstreamReq = http.request({
      agent,
      host: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url || '/',
      headers: buildUpstreamHeaders(req.headers, target),
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      const headers = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        const key = name.toLowerCase();
        if (HOP_BY_HOP.has(key) || value === undefined) continue;
        headers[key] = value;
      }
      if (headers.location !== undefined) {
        const rewritten = rewriteLocation(String(headers.location), target);
        if (rewritten === null) {
          upstreamRes.resume();
          logger.warn('[remote-gateway] refused redirect to another origin', { status, url: req.url });
          sendJson(res, 502, {
            success: false,
            code: 'UPSTREAM_REDIRECT_TO_OTHER_ORIGIN',
            location: String(headers.location),
          });
          return;
        }
        headers.location = rewritten;
      }
      res.writeHead(status, headers);
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (error) => {
      const mismatch = error?.code === 'UPSTREAM_CERT_MISMATCH';
      const offline = OFFLINE_CODES.has(error?.code);
      const status = mismatch ? 495 : offline ? 503 : 502;
      logger.warn('[remote-gateway] upstream request failed', {
        method: req.method,
        url: req.url,
        code: error?.code || null,
        message: error?.message || String(error),
        status,
      });
      sendJson(res, status, {
        success: false,
        code: mismatch ? 'UPSTREAM_CERT_MISMATCH' : offline ? 'BACKEND_OFFLINE' : 'PROXY_ERROR',
      }, { 'x-proxy-error': mismatch ? 'upstream_cert_mismatch' : offline ? 'backend_offline' : 'proxy_error' });
    });

    req.on('aborted', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  function handleUpgrade(req, socket, head) {
    const rejection = checkEntry(req, { requireOrigin: true });
    if (rejection) {
      logger.warn('[remote-gateway] websocket upgrade rejected', { reason: rejection, url: req.url });
      rejectSocket(socket, 403, 'Forbidden');
      return;
    }

    socket.on('error', () => undefined);
    const pending = connectUpstream(target, pinnedFingerprint, (error, upstream) => {
      if (error) {
        logger.warn('[remote-gateway] websocket upstream failed', {
          url: req.url,
          code: error?.code || null,
          message: error?.message || String(error),
        });
        if (!socket.destroyed) rejectSocket(socket, 502, 'Bad Gateway');
        return;
      }
      if (socket.destroyed) {
        upstream.destroy();
        return;
      }
      const lines = [`GET ${req.url || '/'} HTTP/1.1`, `Host: ${target.host}`, 'Connection: Upgrade', 'Upgrade: websocket'];
      for (const [name, value] of Object.entries(buildUpstreamHeaders(req.headers, target))) {
        if (name === 'host') continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      // Server sockets allow half-open connections; a WebSocket ends when either
      // side ends, so tear both down instead of leaving the gateway waiting.
      const teardown = () => {
        socket.destroy();
        upstream.destroy();
      };
      upstream.on('error', teardown);
      socket.on('end', teardown);
      upstream.on('end', teardown);
      socket.on('close', teardown);
      upstream.on('close', teardown);
    });
    socket.on('close', () => pending.destroy());
  }

  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);
  server.on('clientError', (_error, socket) => {
    if (socket.writable) rejectSocket(socket, 400, 'Bad Request');
  });

  return {
    target: target.origin,
    get port() {
      return activePort;
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          activePort = typeof address === 'object' && address ? address.port : requestedPort;
          resolve({ port: activePort, host });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(requestedPort, host);
      });
    },
    close() {
      agent.destroy();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function createFileLogger(logFile) {
  const write = (level, args) => {
    const text = args.map(arg => (typeof arg === 'string' ? arg : (() => {
      try { return JSON.stringify(arg); } catch { return String(arg); }
    })())).join(' ');
    if (level === 'ERROR' || level === 'WARN') console.error(text);
    else console.log(text);
    if (!logFile) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${level.padEnd(5)}] ${text}\n`, 'utf-8');
    } catch {
      // Logging must not take the gateway down.
    }
  };
  return {
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  };
}

function writeReadyFile(readyFile, state) {
  if (!readyFile) return;
  fs.mkdirSync(path.dirname(readyFile), { recursive: true });
  const tempFile = `${readyFile}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString(), ...state }, null, 2), 'utf-8');
  fs.renameSync(tempFile, readyFile);
}

export async function runRemoteGatewayCli(env = process.env) {
  const logger = createFileLogger(env.TX5DR_REMOTE_GATEWAY_LOG_FILE || '');
  const readyFile = env.TX5DR_REMOTE_GATEWAY_READY_FILE || '';
  const requestedPort = Number(env.PORT);
  let gateway;
  try {
    if (!Number.isInteger(requestedPort) || requestedPort <= 0 || requestedPort > 65535) {
      throw Object.assign(new Error('PORT must be a fixed TCP port'), { code: 'INVALID_PORT' });
    }
    gateway = createRemoteGateway({
      target: env.TARGET,
      port: requestedPort,
      tlsFingerprint256: env.TX5DR_UPSTREAM_TLS_FINGERPRINT || null,
      logger,
    });
    const { port } = await gateway.listen();
    writeReadyFile(readyFile, { httpOk: true, httpPort: port, target: gateway.target, error: null });
    logger.info('[remote-gateway] listening', { port, target: gateway.target });
  } catch (error) {
    logger.error('[remote-gateway] startup failed', { code: error?.code || null, message: error?.message || String(error) });
    writeReadyFile(readyFile, {
      httpOk: false,
      httpPort: null,
      target: null,
      error: { code: error?.code || null, message: error?.message || String(error) },
    });
    process.exit(1);
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info('[remote-gateway] shutting down');
    const timer = setTimeout(() => process.exit(0), 1000);
    gateway.close().finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  watchParent(Number(env.TX5DR_REMOTE_GATEWAY_PARENT_PID), stop, logger);
}

/** Whether a process exists; signal 0 only checks, and EPERM still means it is there. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function watchParent(parentPid, stop, logger) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    clearInterval(timer);
    logger.warn('[remote-gateway] desktop client exited, stopping', { parentPid });
    stop();
  }, 2000);
  timer.unref();
}

/** Compares real paths, so a start through a symbolic link or junction still runs the CLI. */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runRemoteGatewayCli();
}
