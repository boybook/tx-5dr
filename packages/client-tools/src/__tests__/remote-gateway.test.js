import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteGateway, normalizeFingerprint, rewriteLocation } from '../remote-gateway.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function startUpstream(handler, options = {}) {
  const seen = [];
  const listener = (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  };
  const server = options.tls ? https.createServer(options.tls, listener) : http.createServer(listener);
  server.on('upgrade', (req, socket) => {
    seen.push({ method: 'UPGRADE', url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', chunk => socket.write(chunk));
    socket.on('end', () => socket.end());
    socket.on('error', () => socket.destroy());
  });
  const port = await listen(server);
  cleanups.push(() => closeServer(server));
  return { port, seen, origin: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}` };
}

async function startGateway(options) {
  const gateway = createRemoteGateway({ port: 0, logger: silentLogger, ...options });
  const { port } = await gateway.listen();
  cleanups.push(() => gateway.close());
  return { gateway, port };
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      agent: false,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /api/ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n\r\n')) {
        const status = Number(data.split(' ')[1]);
        resolve({ status, socket });
      }
    });
    socket.on('error', reject);
    cleanups.push(async () => socket.destroy());
  });
}

function createSelfSignedCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  return {
    cert: certPem,
    key: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint256: new X509Certificate(certPem).fingerprint256,
  };
}

describe('remote gateway forwarding', () => {
  it('forwards pages and API calls to the station without browser origin or forwarding headers', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`ok ${req.url}`);
    });
    const { port } = await startGateway({ target: upstream.origin });

    const page = await request(port, { path: '/index.html' });
    const api = await request(port, {
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        referer: `http://127.0.0.1:${port}/`,
        'x-forwarded-for': '203.0.113.9',
        'content-type': 'application/json',
      },
      body: '{"token":"x"}',
    });

    expect(page).toMatchObject({ status: 200, body: 'ok /index.html' });
    expect(api).toMatchObject({ status: 200, body: 'ok /api/auth/login' });
    const forwarded = upstream.seen.find(entry => entry.url === '/api/auth/login').headers;
    expect(forwarded.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(forwarded).not.toHaveProperty('origin');
    expect(forwarded).not.toHaveProperty('referer');
    expect(forwarded).not.toHaveProperty('x-forwarded-for');
    expect(forwarded['content-type']).toBe('application/json');
  });

  it('rejects other hosts and other page origins before contacting the station', async () => {
    const upstream = await startUpstream((_req, res) => res.end('ok'));
    const { port } = await startGateway({ target: upstream.origin });

    const rebinding = await request(port, { headers: { host: `evil.example:${port}` } });
    const otherPort = await request(port, { headers: { host: '127.0.0.1:1' } });
    const crossSite = await request(port, { path: '/api/station/info', headers: { origin: 'https://evil.example' } });

    expect(rebinding.status).toBe(403);
    expect(otherPort.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(JSON.parse(crossSite.body)).toMatchObject({ code: 'GATEWAY_FORBIDDEN', reason: 'origin_not_allowed' });
    expect(upstream.seen).toHaveLength(0);
  });

  it('keeps same-station redirects inside the gateway and refuses others', async () => {
    const upstream = await startUpstream((req, res) => {
      const location = req.url === '/same' ? `http://127.0.0.1:${upstream.port}/login?next=1` : 'https://elsewhere.example/';
      res.writeHead(302, { location });
      res.end();
    });
    const { port } = await startGateway({ target: upstream.origin });

    const same = await request(port, { path: '/same' });
    const other = await request(port, { path: '/other' });

    expect(same.status).toBe(302);
    expect(same.headers.location).toBe('/login?next=1');
    expect(other.status).toBe(502);
    expect(JSON.parse(other.body)).toMatchObject({ code: 'UPSTREAM_REDIRECT_TO_OTHER_ORIGIN' });
  });

  it('reports an unreachable station as offline', async () => {
    const probe = net.createServer();
    const deadPort = await listen(probe);
    await closeServer(probe);
    const { port } = await startGateway({ target: `http://127.0.0.1:${deadPort}` });

    const response = await request(port, { path: '/api/station/identity' });

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'BACKEND_OFFLINE' });
  });
});

describe('remote gateway websocket upgrades', () => {
  it('requires the gateway origin and strips it upstream', async () => {
    const upstream = await startUpstream((_req, res) => res.end());
    const { port } = await startGateway({ target: upstream.origin });

    const missing = await upgrade(port, {});
    const foreign = await upgrade(port, { Origin: 'https://evil.example' });
    const own = await upgrade(port, { Origin: `http://127.0.0.1:${port}` });

    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(own.status).toBe(101);
    const forwarded = upstream.seen.filter(entry => entry.method === 'UPGRADE');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].headers).not.toHaveProperty('origin');
    expect(forwarded[0].headers['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
  });
});

describe('remote gateway TLS verification', () => {
  const certificate = createSelfSignedCert();

  it('accepts a self-signed station whose fingerprint is pinned', async () => {
    const upstream = await startUpstream((_req, res) => res.end('secure ok'), { tls: certificate });
    const { port } = await startGateway({ target: upstream.origin, tlsFingerprint256: certificate.fingerprint256 });

    const response = await request(port, { path: '/api/station/identity' });
    const ws = await upgrade(port, { Origin: `http://localhost:${port}` });

    expect(response).toMatchObject({ status: 200, body: 'secure ok' });
    expect(ws.status).toBe(101);
  });

  it('refuses a station presenting another certificate without sending the request', async () => {
    const upstream = await startUpstream((_req, res) => res.end('should not reach'), { tls: certificate });
    const wrong = '00'.repeat(32);
    const { port } = await startGateway({ target: upstream.origin, tlsFingerprint256: wrong });

    const response = await request(port, { path: '/api/auth/login', method: 'POST', body: 'secret' });
    const ws = await upgrade(port, { Origin: `http://127.0.0.1:${port}` });

    expect(response.status).toBe(495);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'UPSTREAM_CERT_MISMATCH' });
    expect(ws.status).toBe(502);
    expect(upstream.seen).toHaveLength(0);
  });

  it('uses system trust when no fingerprint is pinned', async () => {
    const upstream = await startUpstream((_req, res) => res.end('should not reach'), { tls: certificate });
    const { port } = await startGateway({ target: upstream.origin });

    const response = await request(port, { path: '/' });

    expect(response.status).toBe(502);
    expect(upstream.seen).toHaveLength(0);
  });
});

describe('remote gateway configuration', () => {
  it('only listens on loopback and only pins https targets', () => {
    expect(() => createRemoteGateway({ target: 'http://192.0.2.1:8076', host: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => createRemoteGateway({ target: 'http://192.0.2.1:8076', tlsFingerprint256: '00'.repeat(32) })).toThrow(/https/);
    expect(() => createRemoteGateway({ target: 'https://192.0.2.1:8443', tlsFingerprint256: 'nope' })).toThrow(/fingerprint/);
    expect(() => createRemoteGateway({ target: 'ftp://192.0.2.1' })).toThrow(/protocol/);
  });

  it('normalizes fingerprints and rewrites only same-origin locations', () => {
    expect(normalizeFingerprint('ab'.repeat(32))).toBe(Array(32).fill('AB').join(':'));
    const target = { url: new URL('http://192.0.2.1:8076/'), origin: 'http://192.0.2.1:8076' };
    expect(rewriteLocation('/x', target)).toBe('/x');
    expect(rewriteLocation('http://192.0.2.1:8076/a?b#c', target)).toBe('/a?b#c');
    expect(rewriteLocation('https://192.0.2.1:8443/', target)).toBeNull();
  });
});

describe('remote gateway command line', () => {
  it('starts through a symbolic link and stops once the desktop client is gone', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx5dr-gateway-cli-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const source = fileURLToPath(new URL('../remote-gateway.js', import.meta.url));
    const linkDir = path.join(dir, 'linked');
    fs.symlinkSync(path.dirname(source), linkDir, 'dir');

    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const probe = net.createServer();
    const port = await listen(probe);
    await new Promise(resolve => probe.close(resolve));
    const readyFile = path.join(dir, 'ready.json');
    const gateway = spawn(process.execPath, [path.join(linkDir, 'remote-gateway.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        TARGET: 'http://127.0.0.1:9',
        TX5DR_REMOTE_GATEWAY_READY_FILE: readyFile,
        TX5DR_REMOTE_GATEWAY_PARENT_PID: String(parent.pid),
      },
      stdio: 'ignore',
    });
    const exited = new Promise(resolve => gateway.once('exit', code => resolve(code)));
    cleanups.push(async () => { gateway.kill(); parent.kill(); });

    await expect.poll(() => fs.existsSync(readyFile), { timeout: 5000 }).toBe(true);
    expect(JSON.parse(fs.readFileSync(readyFile, 'utf8')).httpOk).toBe(true);

    parent.kill();
    await expect(Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('still running'), 6000))])).resolves.toBe(0);
  }, 15000);
});
