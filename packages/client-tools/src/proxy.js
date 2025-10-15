// Minimal static+proxy server for production and standalone access.
// - Serves built web (packages/web/dist)
// - Proxies /api and WebSocket to backend (TARGET)
// - Can bind 0.0.0.0 to be reachable on LAN/Internet

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || (process.env.PUBLIC === '1' ? '0.0.0.0' : '127.0.0.1');
const TARGET = process.env.TARGET || 'http://127.0.0.1:4000';

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

function proxyHttp(req, res) {
  const targetUrl = new URL(TARGET);
  const isTLS = targetUrl.protocol === 'https:';
  const client = isTLS ? https : http;

  const headers = { ...req.headers };
  headers['host'] = targetUrl.host;
  headers['x-forwarded-for'] = (req.socket.remoteAddress || '') + (headers['x-forwarded-for'] ? `, ${headers['x-forwarded-for']}` : '');
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = req.headers.host || '';

  const options = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isTLS ? 443 : 80),
    method: req.method,
    path: req.url, // keep /api prefix
    headers,
  };

  const proxyReq = client.request(options, (proxyRes) => {
    // Pass through headers; add minimal CORS
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (typeof v !== 'undefined') res.setHeader(k, v);
    }
    addCors(res);
    res.writeHead(proxyRes.statusCode || 500);
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', () => {
    res.statusCode = 502;
    addCors(res);
    res.end('Bad Gateway');
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }
}

const server = http.createServer((req, res) => {
  try {
    const parsed = url.parse(req.url || '/');
    let pathname = decodeURIComponent(parsed.pathname || '/');

    // CORS preflight
    if (req.method === 'OPTIONS') {
      addCors(res);
      res.statusCode = 204;
      return res.end();
    }

    // Reverse proxy for API
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return proxyHttp(req, res);
    }

    if (pathname === '/') pathname = '/index.html';
    const absPath = path.join(STATIC_DIR, pathname);

    // Prevent path traversal
    if (!absPath.startsWith(path.resolve(STATIC_DIR))) {
      res.statusCode = 403;
      addCors(res);
      res.end('Forbidden');
      return;
    }

    // If not exists and looks like SPA route, fall back to index.html
    if (!fs.existsSync(absPath)) {
      return serveFile(res, path.join(STATIC_DIR, 'index.html'));
    }
    return serveFile(res, absPath);
  } catch {
    res.statusCode = 500;
    addCors(res);
    res.end('Internal Server Error');
  }
});

// WebSocket proxy for /api/ws (and any /api/* upgrades)
server.on('upgrade', (req, socket, head) => {
  try {
    const u = url.parse(req.url || '/');
    const pathname = u.pathname || '';
    if (!(pathname === '/api/ws' || pathname.startsWith('/api/'))) {
      socket.destroy();
      return;
    }
    const target = new URL(TARGET);
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const upstream = net.connect(port, target.hostname, () => {
      const headers = [
        `GET ${req.url} HTTP/1.1`,
        `Host: ${target.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
      ];
      const hopByHop = new Set(['connection', 'upgrade', 'host']);
      for (const [k, v] of Object.entries(req.headers)) {
        if (!v) continue;
        if (hopByHop.has(k.toLowerCase())) continue;
        if (Array.isArray(v)) {
          for (const vv of v) headers.push(`${k}: ${vv}`);
        } else {
          headers.push(`${k}: ${v}`);
        }
      }
      headers.push('', '');
      upstream.write(headers.join('\r\n'));
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  } catch {
    socket.destroy();
  }
});

server.on('listening', () => {
  console.log(`[client-tools] static server listening on http://${HOST}:${PORT}`);
  console.log(`[client-tools] static dir: ${STATIC_DIR}`);
  console.log(`[client-tools] api target: ${TARGET}`);
});

server.on('error', (err) => {
  console.error('[client-tools] server error:', err);
  process.exit(1);
});

server.listen(PORT, HOST);

// graceful shutdown
function shutdown() {
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
