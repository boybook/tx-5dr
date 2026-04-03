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

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || (process.env.PUBLIC === '1' ? '0.0.0.0' : '127.0.0.1');
const TARGET = process.env.TARGET || 'http://127.0.0.1:4000';
const DEV_WEB_TARGET = process.env.DEV_WEB_TARGET || '';
const LIVEKIT_TARGET = process.env.LIVEKIT_TARGET || '';
const HTTPS_ENABLE = process.env.HTTPS_ENABLE === '1';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const HTTPS_CERT_FILE = process.env.HTTPS_CERT_FILE || '';
const HTTPS_KEY_FILE = process.env.HTTPS_KEY_FILE || '';
const HTTPS_REDIRECT_EXTERNAL_HTTP = process.env.HTTPS_REDIRECT_EXTERNAL_HTTP !== '0';

// DEFAULT to packaged path layout; allow override via STATIC_DIR
const resourcesPath = process.env.APP_RESOURCES || process.cwd();
const defaultStaticDir = path.join(resourcesPath, 'app', 'packages', 'web', 'dist');
const STATIC_DIR = process.env.STATIC_DIR || defaultStaticDir;

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
    stream.on('error', () => {
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
  const forwardedPort = parsedHost.port || String(entryScheme === 'https' ? HTTPS_PORT : PORT);
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

function stripPrefixFromUrl(rawUrl, prefix) {
  const parsed = url.parse(rawUrl || '/');
  const pathname = parsed.pathname || '/';
  let nextPathname = pathname;

  if (pathname === prefix) {
    nextPathname = '/';
  } else if (pathname.startsWith(`${prefix}/`)) {
    nextPathname = pathname.slice(prefix.length) || '/';
  }

  return url.format({
    ...parsed,
    pathname: nextPathname,
  });
}

function shouldRedirectToHttps(req) {
  if (!HTTPS_ENABLE || !HTTPS_REDIRECT_EXTERNAL_HTTP) return false;
  const { hostname } = parseHostHeader(req.headers.host || '');
  return Boolean(hostname) && !isLoopbackHostname(hostname);
}

function buildHttpsRedirectUrl(req) {
  const parsed = parseHostHeader(req.headers.host || '');
  const hostname = parsed.hostname || 'localhost';
  const targetHost = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `https://${targetHost}:${HTTPS_PORT}${req.url || '/'}`;
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

    if (LIVEKIT_TARGET && (pathname === '/livekit' || pathname.startsWith('/livekit/'))) {
      return proxyHttp(
        req,
        res,
        entryScheme,
        LIVEKIT_TARGET,
        (requestUrl) => stripPrefixFromUrl(requestUrl, '/livekit'),
      );
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
      return serveFile(res, path.join(STATIC_DIR, 'index.html'));
    }
    return serveFile(res, absPath);
  } catch {
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
      const isLiveKitUpgrade = LIVEKIT_TARGET && (pathname === '/livekit' || pathname.startsWith('/livekit/'));
      const targetBase = isApiUpgrade ? TARGET : (isLiveKitUpgrade ? LIVEKIT_TARGET : DEV_WEB_TARGET);
      if (!targetBase) {
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
      const upstreamPath = isLiveKitUpgrade
        ? stripPrefixFromUrl(req.url || '/', '/livekit')
        : (req.url || '/');
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

      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    } catch {
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
    httpsServer = null;
  }
}

const httpsSockets = httpsServer ? trackSockets(httpsServer) : null;

httpServer.on('listening', () => {
  const addr = httpServer.address();
  const finalPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`[client-tools] http server listening on http://${HOST}:${finalPort}`);
  console.log(`[client-tools] static dir: ${STATIC_DIR}`);
  console.log(`[client-tools] api target: ${TARGET}`);
  if (LIVEKIT_TARGET) {
    console.log(`[client-tools] livekit target: ${LIVEKIT_TARGET}`);
  }
  if (DEV_WEB_TARGET) {
    console.log(`[client-tools] dev web target: ${DEV_WEB_TARGET}`);
  }
});

httpServer.on('error', (err) => {
  console.error('[client-tools] server error:', err);
  process.exit(1);
});

if (httpsServer) {
  httpsServer.on('listening', () => {
    console.log(`[client-tools] https server listening on https://${HOST}:${HTTPS_PORT}`);
  });

  httpsServer.on('error', (err) => {
    console.error('[client-tools] https server error:', err);
  });
}

function listenWithFallback(server, startPort, host) {
  return new Promise((resolve) => {
    let attempt = 0;
    function tryListen(p) {
      server.once('error', onError);
      server.listen(p, host, () => {
        server.off('error', onError);
        resolve(true);
      });
      function onError(err) {
        server.off('error', onError);
        if (err && err.code === 'EADDRINUSE' && attempt < 50) {
          attempt += 1;
          const next = p + 1;
          console.warn(`[client-tools] port ${p} in use, trying ${next}...`);
          setTimeout(() => tryListen(next), 100);
        } else {
          console.error('[client-tools] failed to bind port:', err?.code || err);
          resolve(false);
        }
      }
    }
    tryListen(startPort);
  });
}

function listenExact(server, port, host) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      console.error('[client-tools] failed to bind HTTPS port:', err?.code || err);
      resolve(false);
    });
    server.listen(port, host, () => resolve(true));
  });
}

Promise.all([
  listenWithFallback(httpServer, Number(PORT), HOST),
  httpsServer ? listenExact(httpsServer, Number(HTTPS_PORT), HOST) : Promise.resolve(true),
]).then(([httpOk, httpsOk]) => {
  if (!httpOk) process.exit(1);
  if (!httpsOk && httpsServer) {
    try { httpsServer.close(); } catch {}
  }
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  const closers = [
    closeServerFast(httpServer, httpSockets),
    httpsServer && httpsSockets ? closeServerFast(httpsServer, httpsSockets) : Promise.resolve(),
  ];
  Promise.allSettled(closers).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[client-tools] uncaught exception:', err.message);
});
