import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANDROID_AUDIO_OUTPUT_HEADER_BYTES,
  AndroidAudioInputSocket,
  AndroidAudioOutputSocket,
  encodeAndroidAudioOutputHeader,
  encodeAndroidAudioPayload,
  writeBufferWithBackpressure,
} from '../AndroidAudioSocketBackend.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class FakeDrainableSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableLength = 0;
  writes = 0;

  constructor(private readonly writeResult: boolean) {
    super();
  }

  write(_buffer: Buffer): boolean {
    this.writes += 1;
    return this.writeResult;
  }
}

class FakeNetSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableLength = 0;
  writes: Buffer[] = [];

  write(buffer: Buffer): boolean {
    this.writes.push(Buffer.from(buffer));
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.writable = false;
  }
}

const androidDevice = {
  id: 'android-output-21',
  androidDeviceId: 21,
  name: '[Android] USB Audio CODEC',
  direction: 'output' as const,
  kind: 'usb',
  type: 3,
  channels: 1,
  sampleRate: 48000,
  sampleRates: [48000, 44100],
  format: 's16le' as const,
  formats: ['s16le', 'f32le'] as Array<'s16le' | 'f32le'>,
  socketPath: '/opt/tx5dr-data/runtime/sockets/audio-output-21.sock',
  available: true,
  isDefault: true,
};

describe('AndroidAudioSocketBackend output stream contract', () => {
  it('encodes a 44100Hz s16le mono stream header', () => {
    const header = encodeAndroidAudioOutputHeader({ sampleRate: 44100, format: 's16le', channels: 1 });

    expect(header).toHaveLength(ANDROID_AUDIO_OUTPUT_HEADER_BYTES);
    expect(header.subarray(0, 8).toString('ascii')).toBe('TX5DRAO1');
    expect(header.readUInt32LE(8)).toBe(44100);
    expect(header.readUInt8(12)).toBe(1);
    expect(header.readUInt8(13)).toBe(1);
  });

  it('encodes a 44100Hz f32le mono stream header', () => {
    const header = encodeAndroidAudioOutputHeader({ sampleRate: 44100, format: 'f32le', channels: 1 });

    expect(header.subarray(0, 8).toString('ascii')).toBe('TX5DRAO1');
    expect(header.readUInt32LE(8)).toBe(44100);
    expect(header.readUInt8(12)).toBe(2);
    expect(header.readUInt8(13)).toBe(1);
  });

  it('writes the selected stream header immediately after socket connect', async () => {
    const socket = new FakeNetSocket();
    const createConnection = vi.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const output = new AndroidAudioOutputSocket(androidDevice, { sampleRate: 44100, format: 'f32le', channels: 1 });

    const started = output.start();
    socket.emit('connect');
    await started;

    expect(createConnection).toHaveBeenCalledWith({ path: androidDevice.socketPath });
    expect(socket.writes).toHaveLength(1);
    expect(socket.writes[0]?.readUInt32LE(8)).toBe(44100);
    expect(socket.writes[0]?.readUInt8(12)).toBe(2);
    output.stop();
    createConnection.mockRestore();
  });

  it('uses v2 and waits for the route ACK when the endpoint advertises support', async () => {
    const socket = new FakeNetSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const output = new AndroidAudioOutputSocket({
      ...androidDevice,
      capabilities: { outputRouteAck: true },
    }, { sampleRate: 48000, format: 's16le', channels: 1 });

    let startedResolved = false;
    const started = output.start().then(() => { startedResolved = true; });
    socket.emit('connect');
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1));

    expect(socket.writes[0]?.subarray(0, 8).toString('ascii')).toBe('TX5DRAO2');
    expect(startedResolved).toBe(false);
    socket.emit('data', Buffer.from('TX5D'));
    socket.emit('data', Buffer.from('RAK1'));
    await started;
    expect(startedResolved).toBe(true);
    output.stop();
  });

  it('rejects v2 startup when the route ACK is invalid', async () => {
    const socket = new FakeNetSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const output = new AndroidAudioOutputSocket({
      ...androidDevice,
      capabilities: { outputRouteAck: true },
    }, { sampleRate: 48000, format: 's16le', channels: 1 });

    const started = output.start();
    socket.emit('connect');
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
    socket.emit('data', Buffer.from('INVALID!'));

    await expect(started).rejects.toThrow('Invalid Android audio output route ACK');
  });

  it('encodes int16 payload as little-endian signed PCM', () => {
    const payload = encodeAndroidAudioPayload(new Float32Array([1, -1, 0.5, -0.5]), 1, 's16le');

    expect(payload).toHaveLength(8);
    expect(payload.readInt16LE(0)).toBe(32767);
    expect(payload.readInt16LE(2)).toBe(-32768);
    expect(payload.readInt16LE(4)).toBe(16384);
    expect(payload.readInt16LE(6)).toBe(-16384);
  });

  it('encodes float32 payload as little-endian Float32 without int16 conversion', () => {
    const payload = encodeAndroidAudioPayload(new Float32Array([0.5, -0.5]), 1, 'f32le');

    expect(payload).toHaveLength(8);
    expect(payload.readFloatLE(0)).toBeCloseTo(0.5);
    expect(payload.readFloatLE(4)).toBeCloseTo(-0.5);
  });
});

describe('AndroidAudioSocketBackend terminal lifecycle', () => {
  it('rejects input startup when no route-ready frame arrives', async () => {
    vi.useFakeTimers();
    const socket = new FakeNetSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const input = new AndroidAudioInputSocket({ ...androidDevice, direction: 'input' });
    const errors: string[] = [];
    input.on('error', (error) => errors.push(error.message));

    const started = input.start();
    const rejected = expect(started).rejects.toThrow('route-ready frame timed out');
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(3_000);

    await rejected;
    expect(socket.destroyed).toBe(true);
    expect(errors).toEqual(['Android audio input route-ready frame timed out']);
  });

  it('reports an input error only once when error is followed by close', async () => {
    const socket = new FakeNetSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const input = new AndroidAudioInputSocket({ ...androidDevice, direction: 'input' });
    const errors: Error[] = [];
    let closes = 0;
    input.on('error', (error) => errors.push(error));
    input.on('close', () => { closes += 1; });

    const started = input.start();
    socket.emit('connect');
    let startedResolved = false;
    void started.then(() => { startedResolved = true; });
    await Promise.resolve();
    expect(startedResolved).toBe(false);
    socket.emit('data', Buffer.from([0, 0]));
    await started;
    expect(startedResolved).toBe(true);
    socket.emit('error', new Error('input disconnected'));
    socket.emit('close');

    expect(errors.map((error) => error.message)).toEqual(['input disconnected']);
    expect(closes).toBe(0);
  });

  it('reports an output close once and suppresses terminal events after stop', async () => {
    const firstSocket = new FakeNetSocket();
    const secondSocket = new FakeNetSocket();
    const createConnection = vi.spyOn(net, 'createConnection')
      .mockReturnValueOnce(firstSocket as never)
      .mockReturnValueOnce(secondSocket as never);
    const output = new AndroidAudioOutputSocket(androidDevice, { sampleRate: 48000, format: 's16le', channels: 1 });
    const events: string[] = [];
    output.on('error', () => events.push('error'));
    output.on('close', () => events.push('close'));

    const started = output.start();
    firstSocket.emit('connect');
    await started;
    firstSocket.emit('close');
    firstSocket.emit('error', new Error('late error'));
    expect(events).toEqual(['close']);

    const stoppedOutput = new AndroidAudioOutputSocket(androidDevice, { sampleRate: 48000, format: 's16le', channels: 1 });
    stoppedOutput.on('error', () => events.push('stopped-error'));
    stoppedOutput.on('close', () => events.push('stopped-close'));
    const restarted = stoppedOutput.start();
    secondSocket.emit('connect');
    await restarted;
    stoppedOutput.stop();
    secondSocket.emit('close');
    expect(events).toEqual(['close']);
    expect(createConnection).toHaveBeenCalledTimes(2);
  });
});

describe('AndroidAudioSocketBackend backpressure writes', () => {
  it('resolves immediately when socket accepts the chunk', async () => {
    const socket = new FakeDrainableSocket(true);

    const result = await writeBufferWithBackpressure(socket, Buffer.alloc(4), 10);

    expect(result.ok).toBe(true);
    expect(result.backpressured).toBe(false);
    expect(socket.writes).toBe(1);
  });

  it('waits for drain when socket applies backpressure', async () => {
    vi.useFakeTimers();
    const socket = new FakeDrainableSocket(false);
    const promise = writeBufferWithBackpressure(socket, Buffer.alloc(4), 100);

    await vi.advanceTimersByTimeAsync(10);
    socket.emit('drain');
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.backpressured).toBe(true);
    expect(result.waitMs).toBeGreaterThanOrEqual(0);
  });

  it('fails when drain does not arrive before timeout', async () => {
    vi.useFakeTimers();
    const socket = new FakeDrainableSocket(false);
    const promise = writeBufferWithBackpressure(socket, Buffer.alloc(4), 25);

    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.backpressured).toBe(true);
  });

  it('fails when the socket closes while waiting for drain', async () => {
    const socket = new FakeDrainableSocket(false);
    const promise = writeBufferWithBackpressure(socket, Buffer.alloc(4), 100);

    socket.emit('close');
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.backpressured).toBe(true);
  });
});
