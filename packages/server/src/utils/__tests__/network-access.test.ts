import { describe, expect, it } from 'vitest';
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
});
