import { afterEach, describe, expect, it } from 'vitest';
import { MockTciServer } from 'tci-client-node/testing';
import { TciSampleType, payloadToFloat32 } from 'tci-client-node';
import type { MeterCapabilities } from '@tx5dr/contracts';
import { TciConnection, resolveTciEndpointCandidates } from '../connections/TciConnection.js';
import { RadioConnectionState, RadioConnectionType, type MeterData } from '../connections/IRadioConnection.js';

let server: MockTciServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('TciConnection', () => {
  async function connectPreparedAudio() {
    server = new MockTciServer();
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();
    await connection.connect({ type: 'tci', tci: {
      host: endpoint.hostname, port: Number(endpoint.port), dialect: 'auto', autoDiscoverPorts: true, receiver: 0, trx: 0, vfo: 0,
      audioEnabled: true, audioSampleRate: 12000,
    } });
    await connection.startAudioStream('tx-output');
    return connection;
  }

  it('serves a dense CHRONO burst entirely from prepared audio and reports consumption, not preparation', async () => {
    const connection = await connectPreparedAudio();
    const samples = Float32Array.from({ length: 512 * 30 + 7 }, (_, i) => (i % 101) / 200);
    const consumed: number[] = [];
    const session = connection.beginPreparedTxAudio(samples, 12000, (count) => consumed.push(count));
    expect(consumed).toEqual([]);
    await expect(connection.sendAudio(new Float32Array(512))).rejects.toThrow('Cannot append');
    for (let index = 0; index < 30; index++) server!.sendTxChrono({ sampleCount: 512 });
    await waitFor(() => server!.receivedTxAudioFrames.length === 30);
    expect(connection.getTxAudioSyncSnapshot()).toMatchObject({ copiedSamples: 512 * 30, underflowSamples: 0, queuedSamples: 7 });
    const received = server!.receivedTxAudioFrames.flatMap((frame) => Array.from(payloadToFloat32(frame)));
    expect(received).toEqual(Array.from(samples.subarray(0, 512 * 30)));
    expect(consumed.at(-1)).toBe(512 * 30);
    const drained = session.drain(1000);
    server!.sendTxChrono({ sampleCount: 512 });
    await drained;
    await waitFor(() => server!.receivedTxAudioFrames.length === 31);
    expect(consumed.at(-1)).toBe(samples.length);
    expect(connection.getTxAudioSyncSnapshot()).toMatchObject({ copiedSamples: samples.length, underflowSamples: 505, queuedSamples: 0 });
    session.end();
    await connection.disconnect();
  });

  it.each(['cancel', 'disconnect', 'remote-disconnect', 'replace'] as const)('invalidates the prepared session on %s without stale cleanup affecting a new transmission', async (reason) => {
    const connection = await connectPreparedAudio();
    const session = connection.beginPreparedTxAudio(new Float32Array(12000), 12000, () => undefined);
    const drained = session.drain(1000).catch((error: unknown) => error);
    if (reason === 'cancel') session.end();
    if (reason === 'disconnect') await connection.disconnect();
    if (reason === 'remote-disconnect') server!.closeClients();
    if (reason === 'replace') connection.beginTxAudio();
    expect(await drained).toBeInstanceOf(Error);
    if (reason !== 'disconnect' && reason !== 'remote-disconnect') {
      connection.beginTxAudio();
      await connection.sendAudio(new Float32Array(512));
      session.end();
      expect(connection.getTxAudioSyncSnapshot()?.queuedSamples).toBe(512);
      await expect(session.drain(1000)).rejects.toThrow('no longer active');
      await connection.disconnect();
    }
    if (reason === 'remote-disconnect') await connection.disconnect();
  });

  it('fails prepared playback if a CHRONO request changes the audio format', async () => {
    const connection = await connectPreparedAudio();
    const errors: unknown[] = [];
    connection.on('error', (error) => errors.push(error));
    const session = connection.beginPreparedTxAudio(new Float32Array(12000), 12000, () => undefined);
    const drained = session.drain(1000).catch((error: unknown) => error);
    server!.sendTxChrono({ sampleRate: 48000, sampleCount: 512 });
    expect(await drained).toBeInstanceOf(Error);
    expect(errors).toHaveLength(1);
    expect(connection.getTxAudioSyncSnapshot()).toBeNull();
    await connection.disconnect();
  });

  it('keeps prepared PCM output intact when a consumption observer throws', async () => {
    const connection = await connectPreparedAudio();
    const session = connection.beginPreparedTxAudio(new Float32Array(1024).fill(0.5), 12000, () => { throw new Error('preview unavailable'); });
    const drained = session.drain(1000);
    server!.sendTxChrono({ sampleCount: 512 });
    server!.sendTxChrono({ sampleCount: 512 });
    await drained;
    await waitFor(() => server!.receivedTxAudioFrames.length === 2);
    expect(connection.getTxAudioSyncSnapshot()).toMatchObject({ copiedSamples: 1024, underflowSamples: 0 });
    session.end();
    await connection.disconnect();
  });

  it('rejects prepared audio at a different sample rate before replacing the active session', async () => {
    const connection = await connectPreparedAudio();
    connection.beginTxAudio();
    await connection.sendAudio(new Float32Array(512));
    expect(() => connection.beginPreparedTxAudio(new Float32Array(512), 48000, () => undefined)).toThrow('format');
    expect(connection.getTxAudioSyncSnapshot()?.queuedSamples).toBe(512);
    await connection.disconnect();
  });

  it('maps IRadioConnection calls to TCI CAT commands and state', async () => {
    server = new MockTciServer();
    let drive = 30;
    server.onCommand(({ socket, command }) => {
      if (command.name !== 'drive') return false;
      if (command.args.length >= 2) drive = Number(command.args[1]);
      socket.send(`DRIVE:${command.args[0] ?? '0'},${drive};`);
      return true;
    });
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 1,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });
    expect(server.receivedCommands.some((command) => command.name === 'rx_sensors_enable')).toBe(false);
    connection.startBackgroundTasks();
    await waitFor(() => server!.receivedCommands.some((command) => command.name === 'tx_sensors_enable'));

    expect(connection.getType()).toBe(RadioConnectionType.TCI);
    expect(connection.getState()).toBe(RadioConnectionState.CONNECTED);
    expect(connection.getTciIqSupport()).toEqual({
      supported: true,
      currentSampleRate: 48_000,
      supportedSampleRates: [48_000, 96_000, 192_000, 384_000],
    });
    await expect(connection.getTciRxFilterBand()).resolves.toEqual([30, 2700]);
    expect(connection.getTciIqClientOptions()).toMatchObject({
      url: new URL(server.url()).toString(),
      receiver: 0,
      trx: 1,
      vfo: 0,
      dialect: 'expertsdr3-1.9-2.0',
    });

    await connection.setFrequency(21_074_000);
    await connection.setDdsFrequency(21_075_000);
    await connection.setMode('LSB', 'nochange', { intent: 'digital' });
    await connection.setPTT(true);
    await connection.setSplitEnabled(true);
    await connection.setRFPower(0.42);

    expect(await connection.getFrequency()).toBe(21_074_000);
    expect(await connection.getPTT()).toBe(true);
    expect(await connection.getMode()).toMatchObject({ mode: 'DIGL' });
    expect(await connection.getSplitEnabled()).toBe(true);
    expect(await connection.getRFPower()).toBeCloseTo(0.42, 2);
    expect(server.receivedCommands.map((command) => command.raw)).toEqual(expect.arrayContaining([
      'VFO:0,0,21074000',
      'DDS:0,21075000',
      'MODULATION:0,DIGL',
      'TRX:1,true,tci',
      'SPLIT_ENABLE:1,true',
      'DRIVE:1,42',
    ]));

    await connection.disconnect('test complete');
  });

  it('forwards RX/TX audio and meter events through the radio connection abstraction', async () => {
    server = new MockTciServer();
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();
    const audioFrame = onceEvent<Float32Array>(connection, 'audioFrame');
    const meterFrames: MeterData[] = [];
    connection.on('meterData', (data) => meterFrames.push(data));

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });
    connection.startBackgroundTasks();
    await waitFor(() => server!.receivedCommands.some((command) => command.name === 'rx_sensors_enable'));

    await connection.startAudioStream();
    server.sendRxAudioFrame({ sampleType: TciSampleType.FLOAT32, samples: new Float32Array([0, 0.5, -0.5]) });
    const [samples] = await audioFrame;
    expect(Array.from(samples)).toEqual([0, expect.closeTo(0.5, 4), expect.closeTo(-0.5, 4)]);

    await connection.beginTxAudio();
    expect(connection.getTxAudioSyncSnapshot()).toMatchObject({
      active: true,
      sampleRate: 12000,
      samplesPerFrame: 512,
      targetLeadMs: 150,
    });
    await connection.sendAudio(new Float32Array([0.25, -0.25]));
    expect(server.receivedTxAudioFrames).toHaveLength(0);
    server.sendTxChrono({ sampleCount: 2 });
    await waitFor(() => server!.receivedTxAudioFrames.length === 1);
    expect(Array.from(payloadToFloat32(server.receivedTxAudioFrames[0]!))).toEqual([expect.closeTo(0.25, 4), expect.closeTo(-0.25, 4)]);
    await connection.waitForTxAudioDrain(100);
    connection.endTxAudio();

    server.broadcast('RX_CHANNEL_SENSORS:0,0,-71.5;TX_SENSORS:0,-20,12.5,18.25,1.4;');
    await waitFor(() => meterFrames.some((data) => data.level?.raw === -71.5
      && data.power?.watts === 12.5 && data.swr?.swr === 1.4));
    const meterData = meterFrames.at(-1)!;
    expect(meterData.level?.raw).toBe(-71.5);
    expect(meterData.power?.watts).toBe(12.5);
    expect(meterData.power?.percent).toBeNull();
    expect(meterData.swr?.swr).toBe(1.4);

    await connection.stopAudioStream();
    await connection.disconnect('test complete');
  });

  it('responds to TX_CHRONO with padded silence when queued TX audio underflows', async () => {
    server = new MockTciServer();
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });

    connection.beginTxAudio();
    await connection.sendAudio(new Float32Array([0.5]));
    server.sendTxChrono({ sampleCount: 4 });

    await waitFor(() => server!.receivedTxAudioFrames.length === 1);
    expect(Array.from(payloadToFloat32(server.receivedTxAudioFrames[0]!))).toEqual([expect.closeTo(0.5, 4), 0, 0, 0]);

    connection.endTxAudio();
    await connection.disconnect('test complete');
  });

  it('discovers meter capabilities from real frames and clears stale or unkeyed readings', async () => {
    server = new MockTciServer({ echoUnknown: false });
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();
    const meterFrames: MeterData[] = [];
    const capabilityFrames: MeterCapabilities[] = [];
    connection.on('meterData', (data) => meterFrames.push(data));
    connection.on('meterCapabilitiesChanged', (data) => capabilityFrames.push(data));

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });
    expect(connection.getMeterCapabilities()).toEqual({
      strength: false, swr: false, alc: false, power: false, powerWatts: false,
    });
    connection.startBackgroundTasks();
    await waitFor(() => server!.receivedCommands.some((command) => command.name === 'rx_sensors_enable'));

    (connection as unknown as { meterFreshnessMs: number }).meterFreshnessMs = 30;
    server.sendRxMeterFrame({ levelDbm: -88 });
    await waitFor(() => meterFrames.some((data) => data.level?.raw === -88));
    expect(capabilityFrames.at(-1)).toMatchObject({ strength: true, power: false });
    await waitFor(() => meterFrames.some((data) => data.level === null), 500);

    server.broadcast('TRX:0,true;');
    server.sendTxMeterFrame({ rmsPowerWatts: 7.5, peakPowerWatts: 9, swr: 1.3 });
    await waitFor(() => meterFrames.some((data) => data.power?.watts === 7.5));
    expect(meterFrames.at(-1)?.power?.percent).toBeNull();
    expect(capabilityFrames.at(-1)).toMatchObject({ power: true, powerWatts: true, swr: true });

    server.broadcast('TRX:0,false;');
    await waitFor(() => meterFrames.at(-1)?.power === null && meterFrames.at(-1)?.swr === null);
    expect(meterFrames.at(-1)).toMatchObject({ power: null, swr: null, alc: null });
    await connection.disconnect('test complete');
  });

  it('maps AetherSDR ALC dBFS without inventing a power percentage', async () => {
    server = new MockTciServer({
      startupCommands: [
        'PROTOCOL:ExpertSDR3,1.5;',
        'DEVICE:AetherSDR;',
        'VFO:0,0,14074000;',
        'TRX:0,false;',
        'READY;',
      ],
    });
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();
    const meterFrames: MeterData[] = [];
    connection.on('meterData', (data) => meterFrames.push(data));
    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });
    connection.startBackgroundTasks();
    await waitFor(() => server!.receivedCommands.some((command) => command.name === 'tx_sensors_enable'));
    server.sendTxMeterFrame({ rmsPowerWatts: 10, peakPowerWatts: 11, swr: 1.2, alc: -2.5 });
    await waitFor(() => meterFrames.some((data) => data.alc?.raw === -2.5));

    expect(meterFrames.at(-1)).toMatchObject({
      power: { watts: 10, percent: null },
      alc: { raw: -2.5, percent: 87.5, alert: true, unit: 'dbfs' },
    });
    expect(connection.getMeterCapabilities()).toMatchObject({ power: true, swr: true, alc: true });
    await connection.disconnect('test complete');
  });

  it('keeps TCI audio stream open until both RX and TX output owners stop', async () => {
    server = new MockTciServer();
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });

    await connection.startAudioStream('rx-input');
    await connection.startAudioStream('tx-output');
    await connection.stopAudioStream('rx-input');
    expect(server.receivedCommands.filter((command) => command.name === 'audio_stop')).toHaveLength(0);

    await connection.stopAudioStream('tx-output');
    await waitFor(() => server!.receivedCommands.some((command) => command.raw === 'AUDIO_STOP:0'));

    await connection.disconnect('test complete');
  });

  it('skips idempotent frequency and PTT writes when startup state already matches', async () => {
    server = new MockTciServer({
      startupCommands: [
        'PROTOCOL:2.0;',
        'DEVICE:Mock ExpertSDR3;',
        'VFO:0,0,7074000;',
        'TRX:0,false;',
        'READY:true;',
      ],
    });
    server.onCommand(({ command }) => command.name === 'vfo' || command.name === 'trx');
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });
    const commandCountBefore = server.receivedCommands.length;

    await connection.setPTT(false);
    await connection.setFrequency(7_074_000);

    expect(server.receivedCommands).toHaveLength(commandCountBefore);
    expect(connection.getState()).toBe(RadioConnectionState.CONNECTED);

    await connection.disconnect('test complete');
  });

  it('poisons the session after an unconfirmed PTT write and rejects the opposite write', async () => {
    server = new MockTciServer();
    // Suppress the TRX state echo: the command has been sent, but its
    // physical result is intentionally unknown to the client.
    server.onCommand(({ command }) => command.name === 'trx');
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection({ writeTimeoutMs: 25 });

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });

    await expect(connection.setPTT(true)).rejects.toThrow(/timed out|uncertain/i);
    expect(connection.getState()).toBe(RadioConnectionState.ERROR);
    expect(connection.isHealthy()).toBe(false);

    const trxWritesAfterTimeout = server.receivedCommands.filter((command) => command.name === 'trx');
    await expect(connection.setPTT(false)).rejects.toThrow(/uncertain|not connected/i);
    expect(server.receivedCommands.filter((command) => command.name === 'trx')).toEqual(trxWritesAfterTimeout);

    await connection.disconnect('test complete');
  });

  it('downgrades operating-state TCI frequency confirmation timeouts without disconnecting', async () => {
    server = new MockTciServer();
    server.onCommand(({ command }) => command.name === 'vfo');
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });

    const result = await connection.applyOperatingState({ frequency: 7_074_000 });

    expect(result).toMatchObject({ frequencyApplied: false, modeApplied: false });
    expect(connection.getState()).toBe(RadioConnectionState.CONNECTED);
    expect(connection.isHealthy()).toBe(true);

    await connection.disconnect('test complete');
  });

  it('confirms Thetis band switches by readback and preserves CW-shifted DDS state', async () => {
    server = new MockTciServer({
      startupCommands: [
        'PROTOCOL:Thetis,2.0;',
        'DEVICE:ANAN7000DLE;',
        'VFO:0,0,14074000;',
        'DDS:0,14074000;',
        'MODULATION:0,CWU;',
        'READY;',
      ],
    });
    let frequencyHz = 14_074_000;
    let iqCenterHz = 14_074_000;
    // Only queries produce a state response. Writes cannot be acknowledged
    // merely because their command bytes reached the socket.
    server.onCommand(({ socket, command }) => {
      if (command.name === 'vfo') {
        if (command.args.length === 3) frequencyHz = Number(command.args[2]);
        else socket.send(`VFO:0,0,${frequencyHz};`);
        return true;
      }
      if (command.name === 'dds') {
        if (command.args.length === 2) iqCenterHz = Number(command.args[1]) - 600;
        else socket.send(`DDS:0,${iqCenterHz};`);
        return true;
      }
      return false;
    });
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection({ writeTimeoutMs: 1000 });

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        dialect: 'auto',
        autoDiscoverPorts: true,
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });

    const changes: number[] = [];
    connection.on('frequencyChanged', (value) => changes.push(value));
    await expect(connection.applyOperatingState({ frequency: 7_074_000 })).resolves.toMatchObject({ frequencyApplied: true });
    await expect(connection.getFrequency()).resolves.toBe(7_074_000);
    await expect(connection.setDdsFrequency(7_075_000)).resolves.toBeUndefined();
    expect(changes).toEqual([7_074_000]);
    expect(server.receivedCommands.map((command) => command.raw)).toEqual(expect.arrayContaining([
      'VFO:0,0,7074000', 'VFO:0,0', 'DDS:0,7075000', 'DDS:0',
    ]));
    expect(connection.getState()).toBe(RadioConnectionState.CONNECTED);

    await connection.disconnect('test complete');
  });

  it('rejects an unconfirmed Thetis direct frequency write before a TX caller can proceed', async () => {
    server = new MockTciServer({
      startupCommands: ['PROTOCOL:Thetis,2.0;', 'DEVICE:Odyssey;', 'VFO:0,0,14074000;', 'TRX:0,false;', 'READY;'],
    });
    server.onCommand(({ command }) => command.name === 'vfo');
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection({ writeTimeoutMs: 60 });
    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname, port: Number(endpoint.port),
        dialect: 'auto', autoDiscoverPorts: false,
        receiver: 0, trx: 0, vfo: 0,
        audioEnabled: true, audioSampleRate: 12000,
      },
    });
    const changes: number[] = [];
    connection.on('frequencyChanged', (value) => changes.push(value));
    await expect(connection.setFrequency(7_074_000)).rejects.toThrow(/Timed out confirming TCI VFO/);
    expect(changes).toEqual([]);
    expect(connection.isHealthy()).toBe(true);
    expect(server.receivedCommands.filter((command) => command.name === 'vfo').map((command) => command.raw))
      .toEqual(['VFO:0,0,7074000', 'VFO:0,0']);
    await connection.disconnect('test complete');
  });
});

describe('resolveTciEndpointCandidates', () => {
  it('tries ExpertSDR and Thetis/Aether defaults for legacy auto configuration', () => {
    expect(resolveTciEndpointCandidates({
      host: '127.0.0.1', port: 40001, receiver: 0, trx: 0, vfo: 0,
      audioEnabled: true, audioSampleRate: 12000, dialect: 'auto', autoDiscoverPorts: true,
    })).toEqual(['ws://127.0.0.1:40001/', 'ws://127.0.0.1:50001/']);
  });

  it('preserves explicit URLs and brackets IPv6 hosts', () => {
    expect(resolveTciEndpointCandidates({
      host: 'ignored', port: 40001, url: 'wss://radio.example/tci', receiver: 0, trx: 0, vfo: 0,
      audioEnabled: true, audioSampleRate: 12000, dialect: 'auto', autoDiscoverPorts: true,
    })).toEqual(['wss://radio.example/tci']);
    expect(resolveTciEndpointCandidates({
      host: '::1', port: 50001, receiver: 0, trx: 0, vfo: 0,
      audioEnabled: true, audioSampleRate: 12000, dialect: 'auto', autoDiscoverPorts: false,
    })).toEqual(['ws://[::1]:50001/']);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for predicate');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function onceEvent<T>(connection: TciConnection, event: string): Promise<[T]> {
  return new Promise((resolve) => connection.once(event as never, (value: T) => resolve([value])));
}
