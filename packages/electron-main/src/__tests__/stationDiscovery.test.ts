import { describe, expect, it, vi } from 'vitest';
import { StationDiscovery, toStationCandidate, type AnnouncedService } from '../stationDiscovery.js';

const ID = '6f1c2c1e-3d7b-4c55-9a4c-1f5b9a7c2e10';

function service(overrides: Partial<AnnouncedService> = {}): AnnouncedService {
  return {
    name: 'TX-5DR 6f1c2c',
    port: 8076,
    addresses: ['fe80::1', '169.254.1.2', '192.168.1.20'],
    txt: { v: '1', id: ID, proto: 'http' },
    ...overrides,
  };
}

describe('toStationCandidate', () => {
  it('builds a URL from a usable LAN address', () => {
    expect(toStationCandidate(service())).toEqual({ instanceId: ID, url: 'http://192.168.1.20:8076', serviceName: 'TX-5DR 6f1c2c' });
    expect(toStationCandidate(service({ txt: { v: '1', id: ID, proto: 'https' }, port: 8443 }))?.url).toBe('https://192.168.1.20:8443');
    expect(toStationCandidate(service({ addresses: ['fd00::5'] }))?.url).toBe('http://[fd00::5]:8076');
  });

  it('accepts TXT values delivered as bytes', () => {
    const txt = { v: Buffer.from('1'), id: Buffer.from(ID), proto: Buffer.from('http') };
    expect(toStationCandidate(service({ txt }))?.instanceId).toBe(ID);
  });

  it('ignores other versions, malformed IDs and unusable addresses', () => {
    expect(toStationCandidate(service({ txt: { v: '2', id: ID, proto: 'http' } }))).toBeNull();
    expect(toStationCandidate(service({ txt: { v: '1', id: '../etc', proto: 'http' } }))).toBeNull();
    expect(toStationCandidate(service({ txt: { v: '1', id: ID, proto: 'ftp' } }))).toBeNull();
    expect(toStationCandidate(service({ addresses: ['127.0.0.1', 'fe80::1', '169.254.0.9'] }))).toBeNull();
    expect(toStationCandidate(service({ port: 0 }))).toBeNull();
  });
});

describe('StationDiscovery', () => {
  function setup(describeResult: (url: string) => Promise<{ label: string; hostVersion: string | null } | null>) {
    let up: (service: AnnouncedService) => void = () => undefined;
    let down: (service: AnnouncedService) => void = () => undefined;
    const stop = vi.fn();
    const onChange = vi.fn();
    const describe = vi.fn((candidate: { url: string }) => describeResult(candidate.url));
    const discovery = new StationDiscovery({
      browse: (onUp, onDown) => { up = onUp; down = onDown; return { stop }; },
      describe,
      onChange,
    });
    discovery.start();
    return { discovery, up: (s: AnnouncedService) => up(s), down: (s: AnnouncedService) => down(s), stop, onChange, describe };
  }

  it('lists a station only after it was verified and named', async () => {
    const env = setup(async () => ({ label: 'BG7XXX · Shack', hostVersion: '1.2.3' }));
    env.up(service());
    expect(env.discovery.list()).toEqual([]);
    await vi.waitFor(() => expect(env.discovery.list()).toHaveLength(1));
    expect(env.discovery.list()[0]).toEqual({ instanceId: ID, url: 'http://192.168.1.20:8076', label: 'BG7XXX · Shack', hostVersion: '1.2.3' });

    env.up(service());
    expect(env.describe).toHaveBeenCalledTimes(1);
  });

  it('drops announcements whose station does not confirm the identity', async () => {
    const env = setup(async () => null);
    env.up(service());
    await vi.waitFor(() => expect(env.describe).toHaveBeenCalled());
    await Promise.resolve();
    expect(env.discovery.list()).toEqual([]);
  });

  it('removes stations that go away and clears everything on stop', async () => {
    const env = setup(async () => ({ label: 'Shack', hostVersion: null }));
    env.up(service());
    await vi.waitFor(() => expect(env.discovery.list()).toHaveLength(1));

    env.down(service());
    expect(env.discovery.list()).toEqual([]);

    env.up(service({ addresses: ['192.168.1.21'] }));
    await vi.waitFor(() => expect(env.discovery.list()).toHaveLength(1));
    env.discovery.stop();
    expect(env.stop).toHaveBeenCalled();
    expect(env.discovery.list()).toEqual([]);
    expect(env.discovery.running).toBe(false);
  });
});
