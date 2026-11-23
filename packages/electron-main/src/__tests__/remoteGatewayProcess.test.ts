import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteGatewayStartError, RemoteGatewaySupervisor, buildRemoteGatewayEnv } from '../remoteGatewayProcess.js';

const GATEWAY_ENTRY = path.resolve(__dirname, '../../../client-tools/src/remote-gateway.js');

describe('buildRemoteGatewayEnv', () => {
  it('passes the fixed port, target and a pin only for https stations', () => {
    const paths = { readyFile: '/r.json', logFile: '/g.log' };
    const pin = { fingerprint256: 'AB', pinnedAt: 'now' };
    expect(buildRemoteGatewayEnv({ url: 'https://h:8443', gatewayPort: 18100, tls: pin }, paths)).toMatchObject({
      PORT: '18100',
      TARGET: 'https://h:8443',
      TX5DR_UPSTREAM_TLS_FINGERPRINT: 'AB',
    });
    expect(buildRemoteGatewayEnv({ url: 'http://h:8076', gatewayPort: 18100, tls: pin }, paths))
      .not.toHaveProperty('TX5DR_UPSTREAM_TLS_FINGERPRINT');
  });
});

describe('RemoteGatewaySupervisor with the real gateway', () => {
  let dir: string;
  let upstream: http.Server;
  let upstreamPort: number;
  const blockers: net.Server[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-remote-gateway-'));
    upstream = http.createServer((req, res) => res.end(`upstream ${req.url}`));
    upstreamPort = await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port)));
  });

  afterEach(async () => {
    await new Promise(resolve => upstream.close(resolve));
    await Promise.all(blockers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
    await rm(dir, { recursive: true, force: true });
  });

  function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
  }

  function createSupervisor() {
    const spawned: number[] = [];
    const supervisor = new RemoteGatewaySupervisor({
      paths: { readyFile: path.join(dir, 'ready.json'), logFile: path.join(dir, 'gateway.log') },
      spawn: (env) => {
        const child = spawn(process.execPath, [GATEWAY_ENTRY], { env: { ...process.env, ...env }, stdio: 'ignore' });
        spawned.push(child.pid ?? -1);
        return child;
      },
      stop: child => new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
      readyTimeoutMs: 8000,
      pollIntervalMs: 50,
    });
    return { supervisor, spawned };
  }

  function get(port: number, urlPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  }

  it('starts once per configuration and forwards to the station', async () => {
    const { supervisor, spawned } = createSupervisor();
    const port = await freePort();
    const profile = { id: 'aaaaaaaa-1', url: `http://127.0.0.1:${upstreamPort}`, gatewayPort: port };

    await supervisor.ensure(profile);
    await supervisor.ensure(profile);
    expect(spawned).toHaveLength(1);
    expect(await get(port, '/api/station/identity')).toBe('upstream /api/station/identity');

    await supervisor.stop();
    expect(supervisor.runningKey).toBeNull();
  });

  it('reports a taken gateway port as EADDRINUSE', async () => {
    const { supervisor } = createSupervisor();
    const blocker = net.createServer();
    blockers.push(blocker);
    const port = await new Promise<number>(resolve => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)));

    await expect(supervisor.ensure({ id: 'aaaaaaaa-2', url: `http://127.0.0.1:${upstreamPort}`, gatewayPort: port }))
      .rejects.toMatchObject({ name: 'RemoteGatewayStartError', code: 'EADDRINUSE' } satisfies Partial<RemoteGatewayStartError>);
  });
});
