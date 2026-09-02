import { afterEach, describe, expect, it, vi } from 'vitest';
import { TciClient, type TciClientOptions } from 'tci-client-node';
import { MockTciServer } from 'tci-client-node/testing';
import type { SpectrumFrame } from '@tx5dr/contracts';
import type { ComplexSpectrumResult } from 'rubato-fft-node';
import type { TciConnection } from '../../radio/connections/TciConnection.js';
import { TciIqSpectrumSource } from '../TciIqSpectrumSource.js';

const FFT_SIZE = 16_384;

function createTone(offsetHz: number, sampleRate: number): Float32Array {
  const samples = new Float32Array(FFT_SIZE * 2);
  for (let index = 0; index < FFT_SIZE; index++) {
    const phase = 2 * Math.PI * offsetHz * index / sampleRate;
    samples[index * 2] = Math.cos(phase) * 0.5;
    samples[index * 2 + 1] = Math.sin(phase) * 0.5;
  }
  return samples;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createConnection(server: MockTciServer): TciConnection {
  return {
    isConnected: () => true,
    getTciIqSupport: () => ({
      supported: true,
      currentSampleRate: 48_000,
      supportedSampleRates: [48_000, 96_000, 192_000, 384_000],
    }),
    getTciIqClientOptions: () => ({
      url: server.url(),
      receiver: 0,
      trx: 0,
      vfo: 0,
      dialect: 'expertsdr-1.9-2.0',
      connectTimeoutMs: 1000,
      handshakeTimeoutMs: 1000,
      commandTimeoutMs: 1000,
    }),
  } as unknown as TciConnection;
}

describe('TciIqSpectrumSource', () => {
  const servers: MockTciServer[] = [];
  const sources: TciIqSpectrumSource[] = [];

  afterEach(async () => {
    await Promise.all(sources.splice(0).map((source) => source.stop()));
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it('keeps the server sample rate and crops the radio-sdr frame to negotiated IF limits', async () => {
    const server = new MockTciServer();
    servers.push(server);
    await server.start();
    server.onCommand(({ server: currentServer, command }) => {
      if (command.name === 'iq_start') {
        currentServer.sendIqFrame({ samples: createTone(6_000, 384_000) });
      }
    });

    let clientCount = 0;
    const frames: SpectrumFrame[] = [];
    const source = new TciIqSpectrumSource(createConnection(server), {
      clientFactory: (options: TciClientOptions) => {
        clientCount += 1;
        return new TciClient(options);
      },
    });
    sources.push(source);

    await source.start((frame) => frames.push(frame));
    server.broadcast('IF_LIMITS:-10000,10000;');
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.sendIqFrame({ samples: createTone(6_000, 384_000) });
    await waitFor(() => frames.length > 0);

    expect(clientCount).toBe(1);
    expect(server.receivedCommands.some((command) => command.name === 'iq_start')).toBe(true);
    expect(server.receivedCommands.some((command) => command.name === 'iq_samplerate')).toBe(true);
    expect(await source.getCurrentSpan()).toBe(384_000);
    expect(await source.getSupportedSpans()).toEqual([384_000]);
    expect(frames[0]).toMatchObject({
      kind: 'radio-sdr',
      frequencyRange: { min: 14_064_000, max: 14_084_000 },
      binaryData: {
        format: { type: 'int16', length: 16_384, scale: 0.01, offset: 0 },
      },
      meta: {
        sourceBinCount: 16_384,
        displayBinCount: 16_384,
        centerFrequency: 14_074_000,
        spanHz: 20_000,
        nativeFrequencyRange: { min: 13_882_000, max: 14_266_000 },
        radioModel: 'TCI IQ',
        level: {
          domain: 'dbfs',
          unit: 'dBFS',
          reference: 'full-scale',
          calibrated: true,
          min: -120,
          max: 0,
        },
      },
      supplement: {
        frequencyRange: { min: 13_882_000, max: 14_266_000 },
        binaryData: { format: { type: 'int16', length: 512, scale: 0.01, offset: 0 } },
      },
    });
    expect(frames[0]!.supplement?.binaryData.format.length).toBe(512);
    const magnitudeBytes = Buffer.from(frames[0]!.binaryData.data, 'base64');
    expect(magnitudeBytes).toHaveLength(32_768);
    const magnitudeView = new DataView(
      magnitudeBytes.buffer,
      magnitudeBytes.byteOffset,
      magnitudeBytes.byteLength,
    );
    let peakIndex = 0;
    let peakValue = -32768;
    for (let index = 0; index < 16_384; index++) {
      const value = magnitudeView.getInt16(index * 2, true);
      if (value > peakValue) {
        peakValue = value;
        peakIndex = index;
      }
    }
    expect(peakIndex).toBeGreaterThanOrEqual(13_000);
    expect(peakIndex).toBeLessThanOrEqual(13_200);

    await source.stop();
    expect(server.receivedCommands.some((command) => command.name === 'iq_stop')).toBe(true);
  });

  it('uses power-domain aggregation for the wide fallback without max-pool floor lift', () => {
    const source = new TciIqSpectrumSource({} as TciConnection);
    const input = new Int16Array([-8_000, -8_000, -8_000, -2_000]);
    const encoded = Buffer.from(input.buffer).toString('base64');
    const compress = (source as unknown as {
      cropAndCompressMagnitudes: (
        base64: string,
        inputLength: number,
        sampleRate: number,
        window: { minOffsetHz: number; maxOffsetHz: number },
        outputBinCount: number,
        aggregation?: 'max' | 'power-mean-percentile',
        scale?: number,
        offset?: number,
      ) => Int16Array;
    }).cropAndCompressMagnitudes.bind(source);
    const maximum = compress(encoded, input.length, 4_000, { minOffsetHz: -2_000, maxOffsetHz: 2_000 }, 1, 'max', 0.01, 0);
    const fallback = compress(encoded, input.length, 4_000, { minOffsetHz: -2_000, maxOffsetHz: 2_000 }, 1, 'power-mean-percentile', 0.01, 0);

    expect(maximum[0]).toBe(-2_000);
    expect(fallback[0]).toBeGreaterThan(-8_000);
    expect(fallback[0]).toBeLessThan(maximum[0]!);
  });

  it('uses sample-rate readback for zoom and suppresses stale analyzer output', async () => {
    const server = new MockTciServer();
    servers.push(server);
    await server.start();
    server.onCommand(({ server: currentServer, command }) => {
      if (command.name === 'iq_start') {
        currentServer.sendIqFrame({ samples: createTone(6_000, 48_000) });
      }
    });
    const frames: SpectrumFrame[] = [];
    const source = new TciIqSpectrumSource(createConnection(server));
    sources.push(source);

    await source.start((frame) => frames.push(frame));
    const changingSpan = source.setSpan(192_000);
    await waitFor(() => server.receivedCommands.some(
      (command) => command.name === 'iq_samplerate' && command.args[0] === '192000',
    ));
    server.sendIqFrame({ sampleRate: 192_000, samples: createTone(-18_000, 192_000) });
    await changingSpan;
    await waitFor(() => frames.some((frame) => frame.meta.spanHz === 192_000));

    const frame = frames.find((candidate) => candidate.meta.spanHz === 192_000)!;
    expect(await source.getCurrentSpan()).toBe(192_000);
    expect(frame.frequencyRange).toEqual({ min: 13_978_000, max: 14_170_000 });
    expect(frame.binaryData.format.length).toBe(16_384);
  });

  it('reconnects the dedicated IQ connection and restarts streaming after a drop', async () => {
    const server = new MockTciServer();
    servers.push(server);
    await server.start();
    server.onCommand(({ server: currentServer, command }) => {
      if (command.name === 'iq_start') {
        currentServer.sendIqFrame({ samples: createTone(8_000, 48_000) });
      }
    });
    let clientCount = 0;
    const source = new TciIqSpectrumSource(createConnection(server), {
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20,
      clientFactory: (options: TciClientOptions) => {
        clientCount += 1;
        return new TciClient(options);
      },
    });
    sources.push(source);

    await source.start(vi.fn());
    server.closeClients();
    await waitFor(() => clientCount >= 2);
    await waitFor(() => server.receivedCommands.filter((command) => command.name === 'iq_start').length >= 2);

    expect(clientCount).toBe(2);
    expect(await source.getCurrentSpan()).toBe(384_000);
  });

  it('rejects a false text echo when IQ frame headers keep the previous sample rate', async () => {
    const server = new MockTciServer();
    servers.push(server);
    await server.start();
    server.onCommand(({ server: currentServer, socket, command }) => {
      if (command.name === 'iq_start') {
        currentServer.sendIqFrame({ sampleRate: 48_000, samples: createTone(5_000, 48_000) });
        return false;
      }
      if (command.name === 'iq_samplerate') {
        socket.send(`IQ_SAMPLERATE:${command.args[0]};`);
        return true;
      }
      return false;
    });
    const source = new TciIqSpectrumSource(createConnection(server));
    sources.push(source);
    await source.start(vi.fn());

    const negotiating = source.setSpan(96_000);
    for (let index = 0; index < 4; index++) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      server.sendIqFrame({ sampleRate: 48_000, samples: createTone(5_000, 48_000) });
    }

    expect(await negotiating).toBe(48_000);
    expect(await source.getCurrentSpan()).toBe(48_000);
    expect(await source.getSupportedSpans()).toEqual([48_000, 192_000, 384_000]);
  });

  it('cancels an in-flight first-frame wait without leaking or reconnecting', async () => {
    const server = new MockTciServer();
    servers.push(server);
    await server.start();
    let clientCount = 0;
    const source = new TciIqSpectrumSource(createConnection(server), {
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20,
      clientFactory: (options: TciClientOptions) => {
        clientCount += 1;
        return new TciClient(options);
      },
    });
    sources.push(source);

    const starting = source.start(vi.fn());
    await waitFor(() => server.receivedCommands.some((command) => command.name === 'iq_start'));
    await source.stop();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(clientCount).toBe(1);
    expect((server as any).sockets.size).toBe(0);
  });

  it('keeps one FFT in flight and analyzes only the latest pending IQ window', async () => {
    const server = new MockTciServer();
    servers.push(server);
    await server.start();
    server.onCommand(({ server: currentServer, command }) => {
      if (command.name === 'iq_start') {
        currentServer.sendIqFrame({ samples: createTone(8_000, 96_000) });
      }
    });
    const inputs: Float32Array[] = [];
    const pending: Array<(result: ComplexSpectrumResult) => void> = [];
    let active = 0;
    let maxActive = 0;
    const analyzerFactory = vi.fn(() => ({
      analyze: (input: Float32Array) => {
        inputs.push(input);
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<ComplexSpectrumResult>((resolve) => {
          pending.push((result) => {
            active -= 1;
            resolve(result);
          });
        });
      },
    }));
    const result: ComplexSpectrumResult = {
      magnitudesBase64: Buffer.alloc(2048).toString('base64'),
      magnitudesLength: 1024,
      scale: 0.01,
      offset: 0,
      peakOffsetHz: 0,
      peakMagnitude: -10,
      averageMagnitude: -80,
      dynamicRange: 70,
      frequencyResolution: 96_000 / FFT_SIZE,
      spanHz: 96_000,
    };
    const source = new TciIqSpectrumSource(createConnection(server), { analyzerFactory });
    sources.push(source);
    await source.start(vi.fn());

    server.sendIqFrame({ samples: new Float32Array(FFT_SIZE * 2).fill(0.1) });
    await waitFor(() => inputs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 110));
    server.sendIqFrame({ samples: new Float32Array(FFT_SIZE * 2).fill(0.2) });
    server.sendIqFrame({ samples: new Float32Array(FFT_SIZE * 2).fill(0.4) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inputs).toHaveLength(1);

    pending.shift()!(result);
    await waitFor(() => inputs.length === 2);
    expect(maxActive).toBe(1);
    expect(inputs[1]![0]).toBeCloseTo(0.4, 5);
    pending.shift()!(result);
  });
});
