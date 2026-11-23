import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeProbeTransport, probeStation, type StationProbeTransport } from '../stationProbe.js';

const identity = {
  identityVersion: 1,
  product: 'tx5dr',
  instanceId: '6f1c2c1e-3d7b-4c55-9a4c-1f5b9a7c2e10',
  hostVersion: '1.2.3',
  sourceSha: 'abcdef',
  channel: 'release',
  distribution: 'linux-service',
  auth: { enabled: true, allowPublicViewing: false },
  desktopBridge: { minVersion: 1 },
};

function fakeTransport(overrides: Partial<StationProbeTransport>): StationProbeTransport {
  return {
    get: async () => ({ status: 200, body: JSON.stringify(identity) }),
    inspectCertificate: async () => ({ fingerprint256: 'AA:BB', subject: 'CN=x', issuer: 'CN=x', validTo: 'never' }),
    ...overrides,
  };
}

describe('probeStation classification', () => {
  it('accepts a station with a valid identity', async () => {
    const result = await probeStation('http://10.0.0.2:8076', { transport: fakeTransport({}) });
    expect(result).toMatchObject({ kind: 'ok', tls: 'none', identity: { hostVersion: '1.2.3' } });
  });

  it('refuses servers without the identity contract, including older stations', async () => {
    const notFound = fakeTransport({ get: async () => ({ status: 404, body: 'Not Found' }) });
    const html = fakeTransport({ get: async () => ({ status: 200, body: '<html>' }) });
    const otherProduct = fakeTransport({ get: async () => ({ status: 200, body: JSON.stringify({ ...identity, product: 'x' }) }) });
    expect(await probeStation('http://h', { transport: notFound })).toEqual({ kind: 'not-a-station', status: 404 });
    expect(await probeStation('http://h', { transport: html })).toEqual({ kind: 'not-a-station', status: 200 });
    expect(await probeStation('http://h', { transport: otherProduct })).toEqual({ kind: 'not-a-station', status: 200 });
  });

  it('reports a station that needs a newer desktop bridge', async () => {
    const transport = fakeTransport({
      get: async () => ({ status: 200, body: JSON.stringify({ ...identity, desktopBridge: { minVersion: 99 } }) }),
    });
    expect(await probeStation('http://h', { transport })).toMatchObject({ kind: 'bridge-too-old', required: 99 });
  });

  it('treats a proxy reporting a stopped station as unreachable', async () => {
    const proxyDown = fakeTransport({ get: async () => ({ status: 503, body: '{"code":"BACKEND_OFFLINE"}' }) });
    expect(await probeStation('http://h', { transport: proxyDown })).toEqual({ kind: 'unreachable', code: 'HTTP_503' });
  });

  it('reports redirects and unreachable stations', async () => {
    const redirect = fakeTransport({ get: async () => ({ status: 308, location: 'https://h:8443/api/station/identity', body: '' }) });
    const offline = fakeTransport({ get: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } });
    expect(await probeStation('http://h:8076', { transport: redirect })).toEqual({ kind: 'redirect', location: 'https://h:8443/api/station/identity' });
    expect(await probeStation('http://h', { transport: offline })).toEqual({ kind: 'unreachable', code: 'ECONNREFUSED' });
  });

  it('offers an untrusted certificate for confirmation instead of accepting it', async () => {
    const transport = fakeTransport({
      get: async () => { throw Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }); },
    });
    expect(await probeStation('https://h:8443', { transport })).toMatchObject({
      kind: 'certificate-untrusted',
      reason: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      certificate: { fingerprint256: 'AA:BB' },
    });
  });

  it('reports a changed pinned certificate', async () => {
    const transport = fakeTransport({
      get: async () => { throw Object.assign(new Error('mismatch'), { code: 'UPSTREAM_CERT_MISMATCH', actual: 'CC:DD' }); },
    });
    expect(await probeStation('https://h', { transport, pinnedFingerprint256: 'AA:BB' }))
      .toEqual({ kind: 'certificate-changed', expected: 'AA:BB', actual: 'CC:DD' });
  });
});

describe('node probe transport', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  });

  function listen(server: http.Server): Promise<number> {
    servers.push(server);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  }

  function selfSigned() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    const attrs = [{ name: 'commonName', value: 'tx5dr-test' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    return { cert: pem, key: forge.pki.privateKeyToPem(keys.privateKey), fingerprint256: new X509Certificate(pem).fingerprint256 };
  }

  it('probes a plain HTTP station', async () => {
    const port = await listen(http.createServer((req, res) => {
      res.writeHead(req.url === '/api/station/identity' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(identity));
    }));
    expect(await probeStation(`http://127.0.0.1:${port}`, { transport: nodeProbeTransport })).toMatchObject({ kind: 'ok', tls: 'none' });
  });

  it('confirms, pins and then detects a changed self-signed certificate', async () => {
    const certificate = selfSigned();
    const port = await listen(https.createServer(certificate, (_req, res) => res.end(JSON.stringify(identity))));
    const origin = `https://127.0.0.1:${port}`;

    const first = await probeStation(origin, { transport: nodeProbeTransport });
    expect(first).toMatchObject({ kind: 'certificate-untrusted', certificate: { fingerprint256: certificate.fingerprint256 } });

    const pinned = await probeStation(origin, { transport: nodeProbeTransport, pinnedFingerprint256: certificate.fingerprint256 });
    expect(pinned).toMatchObject({ kind: 'ok', tls: 'pinned' });

    const changed = await probeStation(origin, { transport: nodeProbeTransport, pinnedFingerprint256: '00'.repeat(32).match(/.{2}/g)!.join(':') });
    expect(changed).toMatchObject({ kind: 'certificate-changed', actual: certificate.fingerprint256 });
  });
});
