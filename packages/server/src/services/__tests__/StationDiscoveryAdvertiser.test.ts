import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { PluginDistribution, RemoteAccessPreset } from '@tx5dr/contracts';
import {
  StationDiscoveryAdvertiser,
  createBonjourPublisher,
  resolveStationAdvertisement,
  type DiscoveryPublisher,
  type StationAdvertisement,
} from '../StationDiscoveryAdvertiser.js';

const ID = '6f1c2c1e-3d7b-4c55-9a4c-1f5b9a7c2e10';

function decide(distribution: PluginDistribution, preset: RemoteAccessPreset, env: NodeJS.ProcessEnv) {
  return resolveStationAdvertisement({ distribution, preset, env, instanceId: ID });
}

describe('resolveStationAdvertisement', () => {
  it('announces installed servers and desktop stations reachable from the network', () => {
    expect(decide('linux-service', 'lan', { TX5DR_HTTP_PORT: '8076' })).toEqual({
      name: 'TX-5DR 6f1c2c',
      type: 'tx5dr',
      port: 8076,
      host: 'tx5dr-6f1c2c1e.local',
      txt: { v: '1', id: ID, proto: 'http' },
    });
    expect(decide('electron', 'lan', { WEB_PORT: '8077' })?.port).toBe(8077);
    expect(decide('generic-server', 'lan', { TX5DR_DISCOVERY_PORT: '9000', WEB_PORT: '8076' })?.port).toBe(9000);
  });

  it('never announces a station limited to its own machine', () => {
    expect(decide('electron', 'local', { WEB_PORT: '8076', TX5DR_DISCOVERY: '1' })).toBeNull();
  });

  it('keeps a public station quiet unless discovery is asked for', () => {
    expect(decide('linux-service', 'public', { TX5DR_HTTP_PORT: '8076' })).toBeNull();
    expect(decide('electron', 'public', { WEB_PORT: '8076' })).toBeNull();
    expect(decide('linux-service', 'public', { TX5DR_HTTP_PORT: '8076', TX5DR_DISCOVERY: '1' })?.port).toBe(8076);
  });

  it('keeps Docker, Android and development servers quiet unless enabled', () => {
    for (const distribution of ['docker', 'android-bridge', 'web-dev'] as const) {
      expect(decide(distribution, 'lan', { WEB_PORT: '8076' }), distribution).toBeNull();
    }
    expect(decide('docker', 'lan', { TX5DR_DISCOVERY: '1', TX5DR_DISCOVERY_PORT: '80' })?.port).toBe(80);
  });

  it('can be switched off and needs a valid web port', () => {
    expect(decide('linux-service', 'lan', { TX5DR_DISCOVERY: 'off', TX5DR_HTTP_PORT: '8076' })).toBeNull();
    expect(decide('linux-service', 'lan', {})).toBeNull();
    expect(decide('linux-service', 'lan', { TX5DR_HTTP_PORT: 'abc' })).toBeNull();
  });

  it('prefers the HTTPS entrypoint when one is configured', () => {
    expect(decide('electron', 'lan', { WEB_PORT: '8076', TX5DR_DISCOVERY_HTTPS_PORT: '8443' })).toMatchObject({
      port: 8443,
      txt: { proto: 'https' },
    });
  });

  it('announces no callsign, host name or path', () => {
    const advertisement = decide('linux-service', 'lan', { TX5DR_HTTP_PORT: '8076' });
    expect(Object.keys(advertisement!.txt).sort()).toEqual(['id', 'proto', 'v']);
    expect(advertisement!.name).not.toMatch(/[a-z]{2,}\d[a-z]{1,3}/i);
    expect(advertisement!.host).not.toContain(os.hostname().replace(/\.local$/, ''));
  });
});

describe('StationDiscoveryAdvertiser', () => {
  function fakePublisher() {
    const published: StationAdvertisement[] = [];
    const stopped: StationAdvertisement[] = [];
    const destroy = vi.fn(async () => undefined);
    const publisher: DiscoveryPublisher = {
      publish: (advertisement) => {
        published.push(advertisement);
        return { stop: (callback) => { stopped.push(advertisement); callback?.(); } };
      },
      destroy,
    };
    return { publisher, published, stopped, destroy };
  }

  it('publishes, withdraws and republishes as the remote access preset changes', async () => {
    const fake = fakePublisher();
    let preset: RemoteAccessPreset = 'lan';
    const advertiser = new StationDiscoveryAdvertiser({
      env: { TX5DR_HTTP_PORT: '8076' },
      getDistribution: async () => 'linux-service',
      getPreset: () => preset,
      getInstanceId: async () => ID,
      createPublisher: () => fake.publisher,
    });

    await advertiser.refresh();
    expect(fake.published).toHaveLength(1);

    await advertiser.refresh();
    expect(fake.published).toHaveLength(1);

    preset = 'local';
    await advertiser.refresh();
    expect(fake.stopped).toHaveLength(1);
    expect(advertiser.advertisement).toBeNull();

    preset = 'lan';
    await advertiser.refresh();
    expect(fake.published).toHaveLength(2);

    await advertiser.stop();
    expect(fake.stopped).toHaveLength(2);
    expect(fake.destroy).toHaveBeenCalled();
    await advertiser.refresh();
    expect(fake.published).toHaveLength(2);
  });

  it('does not open the network until there is something to announce', async () => {
    const createPublisher = vi.fn(() => fakePublisher().publisher);
    const advertiser = new StationDiscoveryAdvertiser({
      env: {},
      getDistribution: async () => 'docker',
      getPreset: () => 'lan',
      getInstanceId: async () => ID,
      createPublisher,
    });
    await advertiser.refresh();
    await advertiser.stop();
    expect(createPublisher).not.toHaveBeenCalled();
  });

  it('releases the socket once there is nothing to announce', async () => {
    const fake = fakePublisher();
    let preset: RemoteAccessPreset = 'lan';
    const advertiser = new StationDiscoveryAdvertiser({
      env: { TX5DR_HTTP_PORT: '8076' },
      getDistribution: async () => 'linux-service',
      getPreset: () => preset,
      getInstanceId: async () => ID,
      createPublisher: () => fake.publisher,
      getNetworkFingerprint: () => 'a',
    });
    await advertiser.refresh();
    preset = 'local';
    await advertiser.refresh();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    await advertiser.stop();
  });

  it('gives up quietly when the mDNS socket fails and tries again on the next change', async () => {
    let fail: ((error: unknown) => void) | null = null;
    const fakes: ReturnType<typeof fakePublisher>[] = [];
    let preset: RemoteAccessPreset = 'lan';
    const advertiser = new StationDiscoveryAdvertiser({
      env: { TX5DR_HTTP_PORT: '8076' },
      getDistribution: async () => 'linux-service',
      getPreset: () => preset,
      getInstanceId: async () => ID,
      createPublisher: (onSocketError) => {
        fail = onSocketError;
        const fake = fakePublisher();
        fakes.push(fake);
        return fake.publisher;
      },
      getNetworkFingerprint: () => 'a',
    });
    await advertiser.refresh();
    fail!(Object.assign(new Error('bind EADDRINUSE 0.0.0.0:5353'), { code: 'EADDRINUSE' }));
    await vi.waitFor(() => expect(fakes[0].destroy).toHaveBeenCalledTimes(1));
    expect(advertiser.advertisement).toBeNull();
    expect(fakes).toHaveLength(1);

    // A repeated failure is reported again but does not schedule retries by itself.
    fail!(new Error('late socket error'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fakes).toHaveLength(1);

    // The next settings change tries again with a fresh socket.
    preset = 'public';
    await advertiser.refresh();
    preset = 'lan';
    await advertiser.refresh();
    expect(fakes).toHaveLength(2);
    expect(advertiser.advertisement).not.toBeNull();
    await advertiser.stop();
  });

  it('republishes when the addresses of the machine change', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakePublisher();
      let network = '192.168.1.10';
      const advertiser = new StationDiscoveryAdvertiser({
        env: { TX5DR_HTTP_PORT: '8076' },
        getDistribution: async () => 'linux-service',
        getPreset: () => 'lan',
        getInstanceId: async () => ID,
        createPublisher: () => fake.publisher,
        getNetworkFingerprint: () => network,
        networkCheckIntervalMs: 1000,
      });
      await advertiser.refresh();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fake.published).toHaveLength(1);

      network = '10.0.0.5';
      await vi.advanceTimersByTimeAsync(1000);
      await advertiser.refresh();
      expect(fake.published).toHaveLength(2);
      expect(fake.stopped).toHaveLength(1);
      await advertiser.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createBonjourPublisher', () => {
  it('reports a failed bind of the mDNS port instead of throwing it', async () => {
    const dgram = await import('node:dgram');
    const blocker = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    const port = await new Promise<number>((resolve) => {
      blocker.bind(0, '127.0.0.1', () => resolve(blocker.address().port));
    });
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      let fake: StationAdvertisement | null = null;
      const advertiser = new StationDiscoveryAdvertiser({
        env: { TX5DR_HTTP_PORT: '8076' },
        getDistribution: async () => 'linux-service',
        getPreset: () => 'lan',
        getInstanceId: async () => ID,
        createPublisher: (onSocketError) => {
          const publisher = createBonjourPublisher(onSocketError, { port, multicast: false, bind: '127.0.0.1' });
          return {
            publish: (advertisement) => { fake = advertisement; return publisher.publish(advertisement); },
            destroy: () => publisher.destroy(),
          };
        },
        getNetworkFingerprint: () => 'a',
      });
      await advertiser.refresh();
      expect(fake).not.toBeNull();
      await vi.waitFor(() => expect(advertiser.advertisement).toBeNull(), { timeout: 3000 });
      await new Promise(resolve => setTimeout(resolve, 100));
      await advertiser.stop();
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
      blocker.close();
    }
  });
});
