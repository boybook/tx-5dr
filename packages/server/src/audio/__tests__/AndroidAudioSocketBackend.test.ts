import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  ANDROID_AUDIO_OUTPUT_HEADER_BYTES,
  AndroidAudioOutputSocket,
  encodeAndroidAudioOutputHeader,
  encodeAndroidAudioPayload,
  writeBufferWithBackpressure,
} from '../AndroidAudioSocketBackend.js';

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
    vi.useRealTimers();
  });

  it('fails when drain does not arrive before timeout', async () => {
    vi.useFakeTimers();
    const socket = new FakeDrainableSocket(false);
    const promise = writeBufferWithBackpressure(socket, Buffer.alloc(4), 25);

    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.backpressured).toBe(true);
    vi.useRealTimers();
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
