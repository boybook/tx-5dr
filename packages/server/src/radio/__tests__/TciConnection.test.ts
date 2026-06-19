import { afterEach, describe, expect, it } from 'vitest';
import { MockTciServer } from 'tci-client-node/testing';
import { TciSampleType, payloadToFloat32 } from 'tci-client-node';
import { TciConnection } from '../connections/TciConnection.js';
import { RadioConnectionState, RadioConnectionType, type MeterData } from '../connections/IRadioConnection.js';

let server: MockTciServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('TciConnection', () => {
  it('maps IRadioConnection calls to TCI CAT commands and state', async () => {
    server = new MockTciServer();
    await server.start();
    const endpoint = new URL(server.url());
    const connection = new TciConnection();

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        receiver: 0,
        trx: 1,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });

    expect(connection.getType()).toBe(RadioConnectionType.TCI);
    expect(connection.getState()).toBe(RadioConnectionState.CONNECTED);

    await connection.setFrequency(21_074_000);
    await connection.setMode('USB', 'nochange', { intent: 'digital' });
    await connection.setPTT(true);
    await connection.setSplitEnabled(true);
    await connection.setRFPower(0.42);

    expect(await connection.getFrequency()).toBe(21_074_000);
    expect(await connection.getPTT()).toBe(true);
    expect(await connection.getMode()).toMatchObject({ mode: 'DIGU' });
    expect(await connection.getSplitEnabled()).toBe(true);
    expect(await connection.getRFPower()).toBeCloseTo(0.42, 2);
    expect(server.receivedCommands.map((command) => command.raw)).toEqual(expect.arrayContaining([
      'VFO:0,0,21074000',
      'MODULATION:0,DIGU',
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
    const audioFrame = onceEvent<Buffer>(connection, 'audioFrame');
    const meterFrames: MeterData[] = [];
    connection.on('meterData', (data) => meterFrames.push(data));

    await connection.connect({
      type: 'tci',
      tci: {
        host: endpoint.hostname,
        port: Number(endpoint.port),
        receiver: 0,
        trx: 0,
        vfo: 0,
        audioEnabled: true,
        audioSampleRate: 12000,
      },
    });

    await connection.startAudioStream();
    server.sendRxAudioFrame({ sampleType: TciSampleType.FLOAT32, samples: new Float32Array([0, 0.5, -0.5]) });
    const [pcm16] = await audioFrame;
    expect(Array.from(payloadToFloat32(pcm16, TciSampleType.INT16))).toEqual([0, expect.closeTo(0.5, 4), expect.closeTo(-0.5, 4)]);

    await connection.sendAudio(new Float32Array([0.25, -0.25]));
    await waitFor(() => server!.receivedTxAudioFrames.length === 1);
    expect(Array.from(payloadToFloat32(server.receivedTxAudioFrames[0]!))).toEqual([expect.closeTo(0.25, 4), expect.closeTo(-0.25, 4)]);

    server.broadcast('RX_CHANNEL_SENSORS:0,0,-71.5;TX_SENSORS:0,-20,12.5,18.25,1.4;');
    await waitFor(() => meterFrames.some((data) => data.power?.watts === 12.5 && data.swr?.swr === 1.4));
    const meterData = meterFrames.at(-1)!;
    expect(meterData.level?.raw).toBe(-71.5);
    expect(meterData.power?.watts).toBe(12.5);
    expect(meterData.swr?.swr).toBe(1.4);

    await connection.stopAudioStream();
    await connection.disconnect('test complete');
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
