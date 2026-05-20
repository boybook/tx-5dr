import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../utils/logger.js';
import type { AndroidAudioDeviceDescriptor } from './android-audio-devices.js';

const logger = createLogger('AndroidAudioSocketBackend');
const OUTPUT_DRAIN_TIMEOUT_MS = 250;
const OUTPUT_BACKPRESSURE_LOG_INTERVAL_MS = 5_000;

export interface AndroidAudioBackpressureResult {
  ok: boolean;
  backpressured: boolean;
  waitMs: number;
}

interface DrainableSocket {
  destroyed: boolean;
  writable: boolean;
  writableLength?: number;
  write(buffer: Buffer): boolean;
  once(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
}

export interface AndroidAudioInputEvents {
  audioData: (samples: Float32Array, sampleRate: number) => void;
  error: (error: Error) => void;
  close: () => void;
}

export class AndroidAudioInputSocket extends EventEmitter<AndroidAudioInputEvents> {
  private socket: net.Socket | null = null;
  private tail = Buffer.alloc(0);
  private stopped = false;

  constructor(private readonly device: AndroidAudioDeviceDescriptor) {
    super();
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.device.socketPath });
      this.socket = socket;
      let settled = false;
      const onStartupError = (error: Error) => {
        if (!this.stopped) this.emit('error', error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.once('connect', () => {
        settled = true;
        socket.off('error', onStartupError);
        socket.on('error', (error) => {
          if (!this.stopped) this.emit('error', error);
        });
        logger.info('Android audio input socket connected', { device: this.device.name, socketPath: this.device.socketPath });
        resolve();
      });
      socket.once('error', onStartupError);
      socket.on('data', (chunk) => this.handleData(chunk));
      socket.once('close', () => {
        if (!this.stopped) this.emit('close');
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    this.tail = Buffer.alloc(0);
  }

  private handleData(chunk: Buffer): void {
    const data = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;
    const alignedLength = data.length - (data.length % 2);
    this.tail = alignedLength === data.length ? Buffer.alloc(0) : data.subarray(alignedLength);
    if (alignedLength <= 0) return;
    this.emit('audioData', convertS16LeToFloat32(data.subarray(0, alignedLength)), this.device.sampleRate || 48000);
  }
}

export class AndroidAudioOutputSocket {
  private socket: net.Socket | null = null;
  private backpressureCount = 0;
  private backpressureWaitMs = 0;
  private writeFailures = 0;
  private lastBackpressureLogAt = 0;

  constructor(private readonly device: AndroidAudioDeviceDescriptor) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.device.socketPath });
      this.socket = socket;
      let settled = false;
      const onStartupError = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.once('connect', () => {
        settled = true;
        socket.off('error', onStartupError);
        socket.on('error', (error) => {
          logger.warn('Android audio output socket error', { device: this.device.name, error: error.message });
        });
        logger.info('Android audio output socket connected', { device: this.device.name, socketPath: this.device.socketPath });
        resolve();
      });
      socket.once('error', onStartupError);
    });
  }

  stop(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  async write(samples: Float32Array, gain = 1): Promise<boolean> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      const payload = convertFloat32ToS16Le(samples, gain);
      const result = await writeBufferWithBackpressure(socket, payload, OUTPUT_DRAIN_TIMEOUT_MS);
      if (result.backpressured) {
        this.backpressureCount += 1;
        this.backpressureWaitMs += result.waitMs;
      }
      if (!result.ok) {
        this.writeFailures += 1;
      }
      this.maybeLogBackpressure(result.backpressured || !result.ok);
      return result.ok;
    } catch (error) {
      this.writeFailures += 1;
      logger.warn('Android audio output write failed', {
        device: this.device.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private maybeLogBackpressure(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastBackpressureLogAt < OUTPUT_BACKPRESSURE_LOG_INTERVAL_MS) return;
    if (this.backpressureCount <= 0 && this.writeFailures <= 0) return;
    logger.info('Android audio output socket backpressure stats', {
      device: this.device.name,
      backpressureCount: this.backpressureCount,
      backpressureWaitMs: Math.round(this.backpressureWaitMs),
      writeFailures: this.writeFailures,
      writableLength: this.socket?.writableLength ?? 0,
    });
    this.lastBackpressureLogAt = now;
  }
}

export async function writeBufferWithBackpressure(
  socket: DrainableSocket,
  buffer: Buffer,
  timeoutMs = OUTPUT_DRAIN_TIMEOUT_MS,
): Promise<AndroidAudioBackpressureResult> {
  if (socket.destroyed || !socket.writable) {
    return { ok: false, backpressured: false, waitMs: 0 };
  }
  if (socket.write(buffer)) {
    return { ok: true, backpressured: false, waitMs: 0 };
  }
  const startedAt = performance.now();
  const drained = await waitForDrain(socket, timeoutMs);
  return {
    ok: drained,
    backpressured: true,
    waitMs: performance.now() - startedAt,
  };
}

function waitForDrain(socket: DrainableSocket, timeoutMs: number): Promise<boolean> {
  if (socket.destroyed || !socket.writable) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('drain', onDrain);
      socket.off('close', onClose);
      socket.off('error', onError);
      resolve(ok);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('drain', onDrain);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function convertS16LeToFloat32(buffer: Buffer): Float32Array {
  const samples = new Float32Array(buffer.length / 2);
  for (let offset = 0, i = 0; offset + 1 < buffer.length; offset += 2, i++) {
    samples[i] = buffer.readInt16LE(offset) / 32768;
  }
  return samples;
}

function convertFloat32ToS16Le(samples: Float32Array, gain: number): Buffer {
  const buffer = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, (samples[i] ?? 0) * gain));
    buffer.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return buffer;
}
