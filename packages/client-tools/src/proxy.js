// Minimal static+proxy server for production and standalone access.
// - Serves built web (packages/web/dist)
// - Proxies /api and WebSocket to backend (TARGET)
// - Optionally exposes an HTTPS entrypoint for browser/LAN access

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const DEFAULT_HTTP_PORT = 8076;
const DEFAULT_HTTPS_PORT = 8443;
const DEFAULT_PORT_SCAN_STEPS = 50;

const PORT = Number(process.env.PORT || DEFAULT_HTTP_PORT);
const HOST = process.env.HOST || (process.env.PUBLIC === '1' ? '0.0.0.0' : '127.0.0.1');
const TARGET = process.env.TARGET || 'http://127.0.0.1:4000';
const DEV_WEB_TARGET = process.env.DEV_WEB_TARGET || '';
const HTTPS_ENABLE = process.env.HTTPS_ENABLE === '1';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || DEFAULT_HTTPS_PORT);
const HTTPS_CERT_FILE = process.env.HTTPS_CERT_FILE || '';
const HTTPS_KEY_FILE = process.env.HTTPS_KEY_FILE || '';
const HTTPS_REDIRECT_EXTERNAL_HTTP = process.env.HTTPS_REDIRECT_EXTERNAL_HTTP !== '0';
const READY_FILE = process.env.TX5DR_CLIENT_TOOLS_READY_FILE || '';
const LOG_FILE = process.env.TX5DR_CLIENT_TOOLS_LOG_FILE || '';
const PORT_SCAN_STEPS = Number(process.env.TX5DR_PORT_SCAN_STEPS || DEFAULT_PORT_SCAN_STEPS);

// DEFAULT to packaged path layout; allow override via STATIC_DIR
const resourcesPath = process.env.APP_RESOURCES || process.cwd();
const defaultStaticDir = path.join(resourcesPath, 'app', 'packages', 'web', 'dist');
const STATIC_DIR = process.env.STATIC_DIR || defaultStaticDir;
let activeHttpPort = PORT;
let activeHttpsPort = HTTPS_PORT;
let httpsAvailable = false;
let httpsStartupError = null;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function formatLogArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    if (typeof arg === 'object' && arg !== null) {
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }
    return String(arg);
  }).join(' ');
}

function writeFileLog(level, args) {
  if (!LOG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] ${formatLogArgs(args)}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // Avoid recursive logging if the log file cannot be written.
  }
}

function installFileLogger() {
  console.log = (...args) => {
    originalConsole.log(...args);
    writeFileLog('INFO', args);
  };
  console.info = (...args) => {
    originalConsole.info(...args);
    writeFileLog('INFO', args);
  };
  console.warn = (...args) => {
    originalConsole.warn(...args);
    writeFileLog('WARN', args);
  };
  console.error = (...args) => {
    originalConsole.error(...args);
    writeFileLog('ERROR', args);
  };
  console.debug = (...args) => {
    originalConsole.debug(...args);
    writeFileLog('DEBUG', args);
  };
}

installFileLogger();

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}));

function addCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

function serveFile(res, absPath) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      console.warn('[client-tools] static file not found:', {
        path: absPath,
        code: err?.code || null,
        message: err?.message || 'not a file',
      });
      res.statusCode = 404;
      addCors(res);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(absPath).toLowerCase();
    const type = MIME.get(ext) || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    addCors(res);
    const stream = fs.createReadStream(absPath);
    stream.on('error', (streamError) => {
      console.error('[client-tools] static file stream failed:', {
        path: absPath,
        code: streamError?.code || null,
        message: streamError?.message || String(streamError),
      });
      res.statusCode = 500;
      addCors(res);
      res.end('Internal Server Error');
    });
    stream.pipe(res);
  });
}

function parseHostHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return { hostname: '', port: '' };
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end !== -1) {
      const hostname = raw.slice(1, end);
      const port = raw.slice(end + 1).replace(/^:/, '');
      return { hostname, port };
    }
  }
  const [hostname, port = ''] = raw.split(':');
  return { hostname, port };
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function buildForwardedHeaders(req, entryScheme, targetBase = TARGET) {
  const hostHeader = req.headers.host || '';
  const parsedHost = parseHostHeader(hostHeader);
  const forwardedPort = parsedHost.port || String(entryScheme === 'https' ? activeHttpsPort : activeHttpPort);
  const targetUrl = new URL(targetBase);

  return {
    ...req.headers,
    host: targetUrl.host,
    'x-forwarded-for': (req.socket.remoteAddress || '') + (req.headers['x-forwarded-for'] ? `, ${req.headers['x-forwarded-for']}` : ''),
    'x-forwarded-proto': entryScheme,
    'x-forwarded-host': hostHeader,
    'x-forwarded-port': forwardedPort,
  };
}

function proxyHttp(req, res, entryScheme, targetBase = TARGET, rewritePath = null) {
  const targetUrl = new URL(targetBase);
  const isTLS = targetUrl.protocol === 'https:';
  const client = isTLS ? https : http;
  const pathValue = rewritePath ? rewritePath(req.url || '/') : (req.url || '/');
  const headers = buildForwardedHeaders(req, entryScheme, targetBase);

  const options = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isTLS ? 443 : 80),
    method: req.method,
    path: pathValue,
    headers,
    rejectUnauthorized: false,
  };

  const proxyReq = client.request(options, (proxyRes) => {
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (typeof v !== 'undefined') res.setHeader(k, v);
    }
    addCors(res);
    res.writeHead(proxyRes.statusCode || 500);
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', (err) => {
    const offlineCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET']);
    const isOffline = offlineCodes.has(err && err.code);
    const status = isOffline ? 503 : 502;
    console.warn('[client-tools] proxy request failed:', {
      method: req.method,
      url: req.url,
      target: targetBase,
      code: err?.code || null,
      message: err?.message || String(err),
      status,
    });
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'x-proxy-error': isOffline ? 'backend_offline' : 'proxy_error',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };
    res.writeHead(status, headers);
    const body = {
      success: false,
      code: isOffline ? 'BACKEND_OFFLINE' : 'PROXY_ERROR',
      message: isOffline ? '后端服务器未启动或不可达（生产代理）' : '反向代理错误',
    };
    try { res.end(JSON.stringify(body)); } catch { res.end(); }
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }
}

function shouldRedirectToHttps(req) {
  if (!HTTPS_ENABLE || !httpsAvailable || !HTTPS_REDIRECT_EXTERNAL_HTTP) return false;
  const { hostname } = parseHostHeader(req.headers.host || '');
  return Boolean(hostname) && !isLoopbackHostname(hostname);
}

function buildHttpsRedirectUrl(req) {
  const parsed = parseHostHeader(req.headers.host || '');
  const hostname = parsed.hostname || 'localhost';
  const targetHost = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `https://${targetHost}:${activeHttpsPort}${req.url || '/'}`;
}

function handleRequest(req, res, entryScheme) {
  try {
    const parsed = url.parse(req.url || '/');
    let pathname = decodeURIComponent(parsed.pathname || '/');

    if (entryScheme === 'http' && shouldRedirectToHttps(req)) {
      res.writeHead(308, { Location: buildHttpsRedirectUrl(req) });
      return res.end();
    }

    if (req.method === 'OPTIONS') {
      addCors(res);
      res.statusCode = 204;
      return res.end();
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return proxyHttp(req, res, entryScheme);
    }

    if (DEV_WEB_TARGET) {
      return proxyHttp(req, res, entryScheme, DEV_WEB_TARGET);
    }

    if (pathname === '/') pathname = '/index.html';
    const absPath = path.join(STATIC_DIR, pathname);

    if (!absPath.startsWith(path.resolve(STATIC_DIR))) {
      res.statusCode = 403;
      addCors(res);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(absPath)) {
      if (pathname !== '/index.html') {
        console.warn('[client-tools] static file missing, falling back to index:', {
          pathname,
          staticDir: STATIC_DIR,
          fallback: path.join(STATIC_DIR, 'index.html'),
        });
      }
      return serveFile(res, path.join(STATIC_DIR, 'index.html'));
    }
    return serveFile(res, absPath);
  } catch (err) {
    console.error('[client-tools] request handler failed:', {
      method: req?.method,
      url: req?.url,
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    res.statusCode = 500;
    addCors(res);
    res.end('Internal Server Error');
  }
}

function attachUpgrade(server, entryScheme) {
  server.on('upgrade', (req, socket, head) => {
    try {
      const u = url.parse(req.url || '/');
      const pathname = u.pathname || '';
      const isApiUpgrade = pathname === '/api/ws' || pathname.startsWith('/api/');
      const targetBase = isApiUpgrade ? TARGET : DEV_WEB_TARGET;
      if (!targetBase) {
        console.warn('[client-tools] websocket upgrade rejected: no target', {
          url: req.url,
          isApiUpgrade,
        });
        socket.destroy();
        return;
      }
      if (entryScheme === 'http' && shouldRedirectToHttps(req)) {
        socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const target = new URL(targetBase);
      const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
      const upstreamPath = req.url || '/';
      const connect = () => {
        const forwardedHeaders = buildForwardedHeaders(req, entryScheme, targetBase);
        const headers = [
          `GET ${upstreamPath} HTTP/1.1`,
          `Host: ${target.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
        ];
        const hopByHop = new Set(['connection', 'upgrade', 'host']);
        for (const [k, v] of Object.entries(forwardedHeaders)) {
          if (!v) continue;
          if (hopByHop.has(k.toLowerCase())) continue;
          if (Array.isArray(v)) {
            for (const vv of v) headers.push(`${k}: ${vv}`);
          } else {
            headers.push(`${k}: ${v}`);
          }
        }
        headers.push('', '');
        return headers.join('\r\n');
      };

      const upstream = target.protocol === 'https:'
        ? tls.connect({ host: target.hostname, port, rejectUnauthorized: false }, () => {
            upstream.write(connect());
            if (head && head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
          })
        : net.connect(port, target.hostname, () => {
            upstream.write(connect());
            if (head && head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
          });

      socket.on('error', (err) => {
        console.warn('[client-tools] downstream websocket socket error:', {
          url: req.url,
          code: err?.code || null,
          message: err?.message || String(err),
        });
        upstream.destroy();
      });
      upstream.on('error', (err) => {
        console.warn('[client-tools] upstream websocket socket error:', {
          url: req.url,
          target: targetBase,
          code: err?.code || null,
          message: err?.message || String(err),
        });
        socket.destroy();
      });
    } catch (err) {
      console.error('[client-tools] websocket upgrade failed:', {
        url: req?.url,
        message: err?.message || String(err),
        stack: err?.stack || null,
      });
      socket.destroy();
    }
  });
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  return sockets;
}

function destroyTrackedSockets(sockets) {
  for (const socket of sockets) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
}

function closeServerFast(server, sockets) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      destroyTrackedSockets(sockets);
      finish();
    }, 400);

    try {
      server.close(() => {
        clearTimeout(timeout);
        finish();
      });
    } catch {
      clearTimeout(timeout);
      finish();
      return;
    }

    try {
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    } catch {
      // ignore
    }

    setTimeout(() => {
      try {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      } catch {
        // ignore
      }
      destroyTrackedSockets(sockets);
    }, 0);
  });
}

const httpServer = http.createServer((req, res) => handleRequest(req, res, 'http'));
attachUpgrade(httpServer, 'http');
const httpSockets = trackSockets(httpServer);

let httpsServer = null;
if (HTTPS_ENABLE && HTTPS_CERT_FILE && HTTPS_KEY_FILE && fs.existsSync(HTTPS_CERT_FILE) && fs.existsSync(HTTPS_KEY_FILE)) {
  try {
    httpsServer = https.createServer({
      cert: fs.readFileSync(HTTPS_CERT_FILE),
      key: fs.readFileSync(HTTPS_KEY_FILE),
    }, (req, res) => handleRequest(req, res, 'https'));
    attachUpgrade(httpsServer, 'https');
  } catch (err) {
    console.error('[client-tools] failed to create HTTPS server:', err);
    httpsStartupError = {
      code: err?.code || null,
      message: err?.message || String(err),
    };
    httpsServer = null;
  }
} else if (HTTPS_ENABLE) {
  httpsStartupError = {
    code: 'HTTPS_CERT_MISSING',
    message: 'HTTPS requested but certificate or key file is missing',
    certFile: HTTPS_CERT_FILE || null,
    keyFile: HTTPS_KEY_FILE || null,
  };
  console.warn('[client-tools] HTTPS requested but certificate or key file is missing', {
    certFile: HTTPS_CERT_FILE || null,
    keyFile: HTTPS_KEY_FILE || null,
    certExists: HTTPS_CERT_FILE ? fs.existsSync(HTTPS_CERT_FILE) : false,
    keyExists: HTTPS_KEY_FILE ? fs.existsSync(HTTPS_KEY_FILE) : false,
  });
}

const httpsSockets = httpsServer ? trackSockets(httpsServer) : null;
let startupComplete = false;

function writeReadyFile(state) {
  if (!READY_FILE) return;
  try {
    fs.mkdirSync(path.dirname(READY_FILE), { recursive: true });
    fs.writeFileSync(READY_FILE, JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      requestedPort: PORT,
      httpPort: state.httpPort ?? null,
      httpOk: Boolean(state.httpOk),
      requestedHttpsPort: HTTPS_PORT,
      httpsPort: state.httpsPort ?? null,
      httpsOk: Boolean(state.httpsOk),
      httpsEnabled: HTTPS_ENABLE,
      staticDir: STATIC_DIR,
      staticDirExists: fs.existsSync(STATIC_DIR),
      target: TARGET,
      devWebTarget: DEV_WEB_TARGET || null,
      error: state.error ?? null,
    }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[client-tools] failed to write ready file:', {
      readyFile: READY_FILE,
      message: err?.message || String(err),
    });
  }
}

console.info('[client-tools] starting', {
  pid: process.pid,
  requestedPort: PORT,
  host: HOST,
  target: TARGET,
  devWebTarget: DEV_WEB_TARGET || null,
  staticDir: STATIC_DIR,
  staticDirExists: fs.existsSync(STATIC_DIR),
  httpsEnabled: HTTPS_ENABLE,
  requestedHttpsPort: HTTPS_PORT,
  httpsCertExists: HTTPS_CERT_FILE ? fs.existsSync(HTTPS_CERT_FILE) : false,
  httpsKeyExists: HTTPS_KEY_FILE ? fs.existsSync(HTTPS_KEY_FILE) : false,
  readyFile: READY_FILE || null,
  logFile: LOG_FILE || null,
});

httpServer.on('listening', () => {
  const addr = httpServer.address();
  const finalPort = typeof addr === 'object' && addr ? addr.port : PORT;
  activeHttpPort = finalPort;
  console.log(`[client-tools] http server listening on http://${HOST}:${finalPort}`);
  console.log(`[client-tools] static dir: ${STATIC_DIR}`);
  console.log(`[client-tools] api target: ${TARGET}`);
  if (DEV_WEB_TARGET) {
    console.log(`[client-tools] dev web target: ${DEV_WEB_TARGET}`);
  }
});

httpServer.on('error', (err) => {
  if (!startupComplete) return;
  console.error('[client-tools] server error:', err);
  process.exit(1);
});

if (httpsServer) {
  httpsServer.on('listening', () => {
    const addr = httpsServer.address();
    activeHttpsPort = typeof addr === 'object' && addr ? addr.port : HTTPS_PORT;
    httpsAvailable = true;
    console.log(`[client-tools] https server listening on https://${HOST}:${activeHttpsPort}`);
  });

  httpsServer.on('error', (err) => {
    if (!startupComplete) return;
    console.error('[client-tools] https server error:', err);
  });
}

function listenWithFallback(server, startPort, host) {
  return new Promise((resolve) => {
    let attempt = 0;
    function tryListen(p) {
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);

      function onListening() {
        server.off('error', onError);
        resolve({ ok: true, port: p, error: null });
      }

      function onError(err) {
        server.off('error', onError);
        server.off('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && attempt < PORT_SCAN_STEPS) {
          attempt += 1;
          const next = p + 1;
          console.warn(`[client-tools] port ${p} in use, trying ${next}...`);
          setTimeout(() => tryListen(next), 100);
        } else {
          const exhausted = err?.code === 'EADDRINUSE' && attempt >= PORT_SCAN_STEPS;
          const message = exhausted
            ? `Port range ${startPort}-${startPort + PORT_SCAN_STEPS} exhausted`
            : (err?.message || String(err));
          console.error('[client-tools] failed to bind port:', {
            code: err?.code || null,
            message,
            attemptedPort: p,
            startPort,
            endPort: startPort + PORT_SCAN_STEPS,
          });
          resolve({
            ok: false,
            port: null,
            error: {
              code: err?.code || null,
              message,
              attemptedPort: p,
              startPort,
              endPort: startPort + PORT_SCAN_STEPS,
            },
          });
        }
      }
    }
    tryListen(startPort);
  });
}

Promise.all([
  listenWithFallback(httpServer, Number(PORT), HOST),
  httpsServer ? listenWithFallback(httpsServer, Number(HTTPS_PORT), HOST) : Promise.resolve({ ok: !HTTPS_ENABLE, port: null, error: httpsStartupError }),
]).then(([httpResult, httpsResult]) => {
  startupComplete = true;
  if (!httpResult.ok) {
    writeReadyFile({
      httpOk: false,
      httpPort: null,
      httpsOk: Boolean(httpsResult.ok && httpsResult.port),
      httpsPort: httpsResult.port,
      error: httpResult.error,
    });
    process.exit(1);
  }
  activeHttpPort = httpResult.port;
  if (httpsResult.ok && httpsResult.port) {
    activeHttpsPort = httpsResult.port;
    httpsAvailable = true;
  }
  if (!httpsResult.ok && httpsServer) {
    httpsAvailable = false;
    console.warn('[client-tools] HTTPS entrypoint disabled after bind failure:', httpsResult.error);
    try { httpsServer.close(); } catch {}
  }
  writeReadyFile({
    httpOk: true,
    httpPort: httpResult.port,
    httpsOk: Boolean(httpsResult.ok && httpsResult.port),
    httpsPort: httpsResult.ok ? httpsResult.port : null,
    error: httpsResult.ok ? null : httpsResult.error,
  });
  console.info('[client-tools] startup complete', {
    httpPort: httpResult.port,
    httpsPort: httpsResult.ok ? httpsResult.port : null,
    httpsEnabled: HTTPS_ENABLE,
    httpsOk: Boolean(httpsResult.ok && httpsResult.port),
  });
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info('[client-tools] shutting down');

  const closers = [
    closeServerFast(httpServer, httpSockets),
    httpsServer && httpsSockets ? closeServerFast(httpsServer, httpsSockets) : Promise.resolve(),
  ];
  Promise.allSettled(closers).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[client-tools] uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[client-tools] unhandled rejection:', reason);
});
