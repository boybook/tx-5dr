import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getNetworkAccessInfo } from '../network-access.js';

describe('getNetworkAccessInfo', () => {
  it('returns LAN frontend URLs and skips loopback/link-local addresses', () => {
    const info = getNetworkAccessInfo({
      webPort: 8076,
      hostname: 'tx5dr',
      networkInterfaces: {
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] as any[],
        eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }] as any[],
        wlan0: [{ family: 'IPv4', internal: false, address: '169.254.1.2' }] as any[],
      },
    });

    expect(info).toEqual({
      addresses: [{ ip: '192.168.1.10', url: 'http://192.168.1.10:8076' }],
      hostname: 'tx5dr',
      webPort: 8076,
    });
  });

  it('prefers forwarded port over env and option ports for proxied web entrypoints', () => {
    const info = getNetworkAccessInfo({
      forwardedPort: '8443',
      webPort: 8076,
      env: { WEB_PORT: '9000' } as NodeJS.ProcessEnv,
      hostname: 'tx5dr',
      networkInterfaces: {
        eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.2' }] as any[],
      },
    });

    expect(info.webPort).toBe(8443);
    expect(info.addresses[0]?.url).toBe('http://10.0.0.2:8443');
  });

  it('uses an injected Android network access file without enumerating host interfaces', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tx5dr-network-access-'));
    const file = path.join(dir, 'android-network-access.json');
    writeFileSync(file, JSON.stringify({
      hostname: 'android',
      webPort: 8076,
      addresses: [
        { ip: '192.168.1.23' },
        { ip: '127.0.0.1' },
        { ip: '169.254.1.2' },
      ],
    }), 'utf-8');

    const spy = vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
      return {};
    });

    try {
      const info = getNetworkAccessInfo({
        env: { TX5DR_NETWORK_ACCESS_FILE: file } as NodeJS.ProcessEnv,
      });

      expect(spy).not.toHaveBeenCalled();
      expect(info).toEqual({
        addresses: [{ ip: '192.168.1.23', url: 'http://192.168.1.23:8076' }],
        hostname: 'android',
        webPort: 8076,
      });
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty addresses for an invalid injected file without falling back to interface enumeration', () => {
    const spy = vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
      return {
        eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.2' }] as any[],
      };
    });

    try {
      const info = getNetworkAccessInfo({
        env: { TX5DR_NETWORK_ACCESS_FILE: '/definitely/missing/android-network-access.json' } as NodeJS.ProcessEnv,
        webPort: 8076,
      });

      expect(spy).not.toHaveBeenCalled();
      expect(info.addresses).toEqual([]);
      expect(info.hostname).toBe('android');
      expect(info.webPort).toBe(8076);
    } finally {
      spy.mockRestore();
    }
  });
});
