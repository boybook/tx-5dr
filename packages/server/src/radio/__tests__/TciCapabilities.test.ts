import { afterEach, describe, expect, it } from 'vitest';
import { MockTciServer } from 'tci-client-node/testing';
import { TciConnection } from '../connections/TciConnection.js';
import { RadioCapabilityManager } from '../RadioCapabilityManager.js';
import type { RadioConnectionConfig } from '../connections/IRadioConnection.js';
import type { RadioIoQueue } from '../connections/RadioIoQueue.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function createRadio(vendor: 'expert' | 'thetis' | 'aether' = 'expert') {
  let monitor = false;
  let volume = vendor === 'aether' ? 75 : -12;
  let band = [-2900, -70];
  const identity = vendor === 'thetis' ? ['PROTOCOL:Thetis,2.0;', 'DEVICE:ANAN7000DLE;']
    : vendor === 'aether' ? ['PROTOCOL:ExpertSDR3,1.5;', 'DEVICE:AetherSDR;']
      : ['PROTOCOL:ExpertSDR3,2.0;', 'DEVICE:SunSDR2DX;'];
  const server = new MockTciServer({ echoUnknown: false, startupCommands: [...identity,
    'TRX_COUNT:2;', 'CHANNEL_COUNT:2;', 'VFO:0,0,7074000;', 'MODULATIONS_LIST:USB,LSB,DIGU;',
    'MODULATION:0,LSB;', 'TRX:0,false;', 'DRIVE:0,30;', 'SPLIT_ENABLE:0,false;',
    'MON_ENABLE:false;', `MON_VOLUME:${vendor === 'aether' ? 50 : -30};`,
    vendor === 'aether' ? 'RX_VOLUME:0,75;' : 'RX_VOLUME:0,0,-12;',
    'RX_FILTER_BAND:0,-2900,-70;', 'RX_NB_PARAM:0,70,25;', 'RX_NR_ENABLE:0,false;',
    ...(vendor === 'thetis' ? ['RX_NR_ENABLE_EX:0,false,0;', 'TX_FILTER_BAND_EX:30,3000;', 'TX_PROFILES_EX:SSB,Digital;', 'TX_PROFILE_EX:SSB;'] : []),
    'READY;',
  ] });
  server.onCommand(({ command, socket }) => {
    if (command.name === 'mon_enable') {
      if (command.args.length) monitor = command.args[0] === 'true';
      socket.send(`MON_ENABLE:${monitor};`); return true;
    }
    if (command.name === 'rx_volume') {
      const index = vendor === 'aether' ? 1 : 2;
      if (command.args[index] !== undefined) volume = Number(command.args[index]);
      socket.send(vendor === 'aether' ? `RX_VOLUME:0,${volume};` : `RX_VOLUME:0,0,${volume};`);
      return true;
    }
    if (command.name === 'rx_filter_band') {
      if (command.args.length === 3) band = command.args.slice(1).map(Number);
      socket.send(`RX_FILTER_BAND:0,${band[0]},${band[1]};`); return true;
    }
    return false;
  });
  await server.start();
  cleanup.push(() => server.stop());
  const connection = new TciConnection();
  const url = new URL(server.url());
  await connection.connect({ type: 'tci', tci: { host: url.hostname, port: Number(url.port), receiver: 0, trx: 0, vfo: 0 } } as RadioConnectionConfig);
  cleanup.push(() => connection.disconnect('test complete'));
  const manager = new RadioCapabilityManager();
  cleanup.push(async () => manager.onDisconnected());
  await manager.onConnected(connection);
  return { server, connection, manager, monitor: () => monitor, volume: () => volume,
    descriptor: (id: string) => manager.getCapabilitySnapshot().descriptors.find((d) => d.id === id)!,
    state: (id: string) => manager.getCapabilitySnapshot().capabilities.find((s) => s.id === id)!,
  };
}

describe('TCI capability integration', () => {
  it('maps native units without changing the public normalized value contract', async () => {
    const radio = await createRadio();
    expect(radio.state('af_gain').value).toBeCloseTo(0.8);
    expect(radio.descriptor('af_gain')).toMatchObject({ target: { scope: 'channel', receiver: 0, channel: 0 },
      display: { unit: 'dB', transform: { scale: 60, offset: -60 } }, updateMode: 'event' });
    await radio.manager.writeCapability('af_gain', 0.5, undefined, radio.descriptor('af_gain').sessionId);
    expect(radio.volume()).toBe(-30);
    expect(radio.state('af_gain').value).toBe(0.5);
  });

  it('atomically writes both passband edges and projects the actual spectrum passband', async () => {
    const radio = await createRadio();
    const d = radio.descriptor('rx_filter_low');
    await expect(radio.manager.writeCapability('rx_filter_low', -3000)).rejects.toThrow(/group submission/);
    await expect(radio.manager.writeCapabilityGroup('rx_filter_band', { rx_filter_low: -3000 }, d.sessionId!)).rejects.toThrow(/exactly/);
    await expect(radio.manager.writeCapabilityGroup('rx_filter_band', { rx_filter_low: 30, rx_filter_high: -30 }, d.sessionId!)).rejects.toThrow();
    const before = radio.server.receivedCommands.length;
    await radio.manager.writeCapabilityGroup('rx_filter_band', { rx_filter_low: -3000, rx_filter_high: 3000 }, d.sessionId!);
    expect(radio.server.receivedCommands.slice(before).map((c) => c.raw)).toEqual(['RX_FILTER_BAND:0,-3000,3000']);
    expect(radio.state('rx_filter_low').value).toBe(-3000);
    expect(radio.state('rx_filter_high').value).toBe(3000);
    expect(await radio.connection.getTciRxFilterBand()).toEqual([-3000, 3000]);
  });

  it('uses broadcasts for event capabilities and rejects stale sessions', async () => {
    const radio = await createRadio();
    const before = radio.server.receivedCommands.filter((c) => c.name === 'rx_volume').length;
    await radio.manager.refreshAll('automatic');
    expect(radio.server.receivedCommands.filter((c) => c.name === 'rx_volume')).toHaveLength(before);
    radio.server.broadcast('RX_VOLUME:0,0,-24;');
    await eventually(() => radio.state('af_gain').value === 0.6);
    await expect(radio.manager.writeCapability('af_gain', 0.2, undefined, 'old-session')).rejects.toThrow(/session changed/);
    await expect(radio.manager.writeCapabilityGroup('rx_filter_band', { rx_filter_low: 30, rx_filter_high: 2700 }, 'old-session')).rejects.toThrow(/session changed/);
    radio.manager.onDisconnected();
    radio.server.broadcast('RX_VOLUME:0,0,-6;');
    expect(radio.manager.getCapabilitySnapshot()).toEqual({ descriptors: [], capabilities: [] });
  });

  it('initializes MON only once during a connection even across stream restarts', async () => {
    const radio = await createRadio();
    await radio.connection.startLineOutStream();
    expect(radio.monitor()).toBe(true);
    await radio.manager.writeCapability('monitor_enabled', false);
    await radio.connection.stopLineOutStream();
    await radio.connection.startLineOutStream();
    expect(radio.monitor()).toBe(false);
    expect(radio.server.receivedCommands.filter((c) => c.raw === 'MON_ENABLE:true')).toHaveLength(1);
  });

  it('drops an old queued stream start when the connection is replaced', async () => {
    const radio = await createRadio();
    const queue = (radio.connection as unknown as { ioQueue: RadioIoQueue }).ioQueue;
    let release!: () => void;
    const gate = queue.run({ sessionId: 1 }, () => new Promise<void>((done) => { release = done; }));
    const stale = radio.connection.startLineOutStream();
    const assertion = expect(stale).rejects.toThrow(/expired connection/);
    await eventually(() => Boolean(release));
    radio.manager.onDisconnected();
    await radio.connection.disconnect('replace session');
    const url = new URL(radio.server.url());
    await radio.connection.connect({ type: 'tci', tci: { host: url.hostname, port: Number(url.port) } } as RadioConnectionConfig);
    release(); await gate; await assertion;
    expect(radio.server.receivedCommands.some((c) => c.name === 'line_out_start')).toBe(false);
    await radio.connection.startLineOutStream();
    expect(radio.monitor()).toBe(true);
    expect(radio.server.receivedCommands.filter((c) => c.raw === 'MON_ENABLE:true')).toHaveLength(1);
  });

  it('keeps Thetis stream semantics and protects idle-only settings', async () => {
    const radio = await createRadio('thetis');
    expect(radio.state('nr_algorithm').supported).toBe(true);
    expect(radio.state('anc_enabled').supported).toBe(false);
    expect(radio.descriptor('attenuator_level').writable).toBe(false);
    expect(radio.connection.supportsNativeLineOutStream()).toBe(false);
    await radio.connection.startAudioStream();
    expect(radio.server.receivedCommands.some((c) => c.name === 'line_out_start')).toBe(false);
    radio.manager.setPTTActive(true);
    await expect(radio.manager.writeCapability('vfo_swap', undefined, true)).rejects.toThrow(/idle radio/);
    await expect(radio.manager.writeCapabilityGroup('tx_filter_band', { tx_filter_low: 100, tx_filter_high: 2900 }, radio.descriptor('tx_filter_low').sessionId!)).rejects.toThrow(/idle radio/);
  });

  it('uses Aether query addressing and hides placeholder/ambiguous settings', async () => {
    const radio = await createRadio('aether');
    expect(radio.state('af_gain').value).toBe(0.75);
    expect(radio.state('binaural_enabled').supported).toBe(false);
    expect(radio.descriptor('agc_gain').writable).toBe(false);
    expect(radio.descriptor('sql_threshold').writable).toBe(false);
    await radio.manager.refreshDescriptor('af_gain');
    expect(radio.volume()).toBe(75);
    await radio.manager.writeCapability('af_gain', 0.4);
    expect(radio.volume()).toBe(40);
    expect(radio.server.receivedCommands.filter((c) => c.name === 'rx_volume').map((c) => c.raw)).toContain('RX_VOLUME:0');
    expect(radio.server.receivedCommands.some((c) => c.raw === 'RX_VOLUME:0,0')).toBe(false);
  });
});

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}
