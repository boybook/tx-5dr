import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../utils/logger.js';
import type { AndroidAudioDeviceDescriptor } from './android-audio-devices.js';

const logger = createLogger('AndroidAudioSocketBackend');
const OUTPUT_DRAIN_TIMEOUT_MS = 250;
const OUTPUT_BACKPRESSURE_LOG_INTERVAL_MS = 5_000;
const INPUT_ROUTE_READY_TIMEOUT_MS = 3_000;
const OUTPUT_ROUTE_ACK_TIMEOUT_MS = 2_000;
export const ANDROID_AUDIO_OUTPUT_HEADER_BYTES = 16;
const ANDROID_AUDIO_OUTPUT_HEADER_V1_MAGIC = Buffer.from('TX5DRAO1', 'ascii');
const ANDROID_AUDIO_OUTPUT_HEADER_V2_MAGIC = Buffer.from('TX5DRAO2', 'ascii');
const ANDROID_AUDIO_OUTPUT_ROUTE_ACK_MAGIC = Buffer.from('TX5DRAK1', 'ascii');

export type AndroidAudioOutputFormat = 's16le' | 'f32le';

export interface AndroidAudioOutputStreamConfig {
  sampleRate: number;
  format: AndroidAudioOutputFormat;
  channels: 1;
}

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

export interface AndroidAudioOutputEvents {
  error: (error: Error) => void;
  close: () => void;
}

export class AndroidAudioInputSocket extends EventEmitter<AndroidAudioInputEvents> {
  private socket: net.Socket | null = null;
  private tail = Buffer.alloc(0);
  private stopped = false;
  private terminalEventEmitted = false;

  constructor(private readonly device: AndroidAudioDeviceDescriptor) {
    super();
  }

  start(): Promise<void> {
    this.stopped = false;
    this.terminalEventEmitted = false;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.device.socketPath });
      this.socket = socket;
      let settled = false;
      const readyTimeout = setTimeout(() => {
        const error = new Error('Android audio input route-ready frame timed out');
        this.emitTerminalError(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        socket.destroy();
      }, INPUT_ROUTE_READY_TIMEOUT_MS);
      const clearReadyTimeout = () => clearTimeout(readyTimeout);
      const onError = (error: Error) => {
        this.emitTerminalError(error);
        if (!settled) {
          settled = true;
          clearReadyTimeout();
          reject(error);
        }
      };
      socket.once('connect', () => {
        if (this.stopped) {
          if (!settled) {
            settled = true;
            clearReadyTimeout();
            reject(new Error('Android audio input socket stopped before connection completed'));
          }
          socket.destroy();
          return;
        }
      });
      socket.on('error', onError);
      socket.on('data', (chunk) => {
        const frame = this.decodeData(chunk);
        if (!frame) return;
        if (!settled) {
          settled = true;
          clearReadyTimeout();
          logger.info('Android audio input route ready', { device: this.device.name, socketPath: this.device.socketPath });
          resolve();
          queueMicrotask(() => this.emitInputFrame(frame));
          return;
        }
        this.emitInputFrame(frame);
      });
      socket.once('close', () => {
        if (this.socket === socket) this.socket = null;
        if (!settled) {
          settled = true;
          clearReadyTimeout();
          reject(new Error('Android audio input socket closed before connection completed'));
        }
        this.emitTerminalClose();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    this.tail = Buffer.alloc(0);
  }

  private emitTerminalError(error: Error): void {
    if (this.stopped || this.terminalEventEmitted) return;
    this.terminalEventEmitted = true;
    this.emit('error', error);
  }

  private emitTerminalClose(): void {
    if (this.stopped || this.terminalEventEmitted) return;
    this.terminalEventEmitted = true;
    this.emit('close');
  }

  private decodeData(chunk: Buffer): { samples: Float32Array; sampleRate: number } | null {
    if (this.stopped || this.terminalEventEmitted) return null;
    const data = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;
    const alignedLength = data.length - (data.length % 2);
    this.tail = alignedLength === data.length ? Buffer.alloc(0) : data.subarray(alignedLength);
    if (alignedLength <= 0) return null;
    return {
      samples: convertS16LeToFloat32(data.subarray(0, alignedLength)),
      sampleRate: this.device.sampleRate || 48000,
    };
  }

  private emitInputFrame(frame: { samples: Float32Array; sampleRate: number }): void {
    if (this.stopped || this.terminalEventEmitted) return;
    this.emit('audioData', frame.samples, frame.sampleRate);
  }
}

export class AndroidAudioOutputSocket extends EventEmitter<AndroidAudioOutputEvents> {
  private socket: net.Socket | null = null;
  private backpressureCount = 0;
  private backpressureWaitMs = 0;
  private writeFailures = 0;
  private lastBackpressureLogAt = 0;
  private stopped = false;
  private terminalEventEmitted = false;

  constructor(
    private readonly device: AndroidAudioDeviceDescriptor,
    private readonly streamConfig: AndroidAudioOutputStreamConfig,
  ) {
    super();
  }

  start(): Promise<void> {
    this.stopped = false;
    this.terminalEventEmitted = false;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.device.socketPath });
      this.socket = socket;
      let settled = false;
      const onError = (error: Error) => {
        this.emitTerminalError(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.once('connect', () => {
        void (async () => {
          try {
            if (this.stopped) {
              throw new Error('Android audio output socket stopped before connection completed');
            }
            const requiresRouteAck = this.device.capabilities?.outputRouteAck === true;
            const header = encodeAndroidAudioOutputHeader(this.streamConfig, requiresRouteAck);
            const routeAckPromise = requiresRouteAck
              ? waitForAndroidAudioOutputRouteAck(socket, OUTPUT_ROUTE_ACK_TIMEOUT_MS)
              : null;
            void routeAckPromise?.catch(() => undefined);
            const result = await writeBufferWithBackpressure(socket, header, OUTPUT_DRAIN_TIMEOUT_MS);
            if (!result.ok) {
              throw new Error('Android audio output stream header write failed');
            }
            if (routeAckPromise) {
              await routeAckPromise;
            }
            settled = true;
            logger.info('Android audio output socket connected', {
              device: this.device.name,
              socketPath: this.device.socketPath,
              sampleRate: this.streamConfig.sampleRate,
              format: this.streamConfig.format,
              channels: this.streamConfig.channels,
            });
            resolve();
          } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            if (!settled) {
              settled = true;
              reject(normalizedError);
            }
            this.emitTerminalError(normalizedError);
            socket.destroy();
          }
        })();
      });
      socket.on('error', onError);
      socket.once('close', () => {
        if (this.socket === socket) this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error('Android audio output socket closed before connection completed'));
        }
        this.emitTerminalClose();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
  }

  async write(samples: Float32Array, gain = 1): Promise<boolean> {
    const socket = this.socket;
    if (this.stopped || this.terminalEventEmitted || !socket || socket.destroyed || !socket.writable) return false;
    try {
      const payload = encodeAndroidAudioPayload(samples, gain, this.streamConfig.format);
      const result = await writeBufferWithBackpressure(socket, payload, OUTPUT_DRAIN_TIMEOUT_MS);
      if (result.backpressured) {
        this.backpressureCount += 1;
        this.backpressureWaitMs += result.waitMs;
      }
      if (!result.ok) {
        this.writeFailures += 1;
        this.emitTerminalError(new Error('Android audio output socket write failed'));
        socket.destroy();
      }
      this.maybeLogBackpressure(result.backpressured || !result.ok);
      return result.ok;
    } catch (error) {
      this.writeFailures += 1;
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logger.warn('Android audio output write failed', {
        device: this.device.name,
        error: normalizedError.message,
      });
      this.emitTerminalError(normalizedError);
      socket.destroy();
      return false;
    }
  }

  private emitTerminalError(error: Error): void {
    if (this.stopped || this.terminalEventEmitted) return;
    this.terminalEventEmitted = true;
    logger.warn('Android audio output socket error', { device: this.device.name, error: error.message });
    this.emit('error', error);
  }

  private emitTerminalClose(): void {
    if (this.stopped || this.terminalEventEmitted) return;
    this.terminalEventEmitted = true;
    this.emit('close');
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

export function encodeAndroidAudioOutputHeader(config: AndroidAudioOutputStreamConfig, requiresRouteAck = false): Buffer {
  if (!Number.isFinite(config.sampleRate) || config.sampleRate < 8_000 || config.sampleRate > 192_000) {
    throw new Error(`Invalid Android audio output sample rate: ${config.sampleRate}`);
  }
  if (config.channels !== 1) {
    throw new Error(`Invalid Android audio output channel count: ${config.channels}`);
  }
  const formatId = config.format === 's16le' ? 1 : config.format === 'f32le' ? 2 : 0;
  if (formatId === 0) {
    throw new Error(`Invalid Android audio output format: ${String(config.format)}`);
  }
  const header = Buffer.alloc(ANDROID_AUDIO_OUTPUT_HEADER_BYTES);
  (requiresRouteAck ? ANDROID_AUDIO_OUTPUT_HEADER_V2_MAGIC : ANDROID_AUDIO_OUTPUT_HEADER_V1_MAGIC).copy(header, 0);
  header.writeUInt32LE(Math.round(config.sampleRate), 8);
  header.writeUInt8(formatId, 12);
  header.writeUInt8(config.channels, 13);
  header.writeUInt16LE(0, 14);
  return header;
}

export function waitForAndroidAudioOutputRouteAck(socket: net.Socket, timeoutMs = OUTPUT_ROUTE_ACK_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      received = received.length > 0 ? Buffer.concat([received, chunk]) : Buffer.from(chunk);
      if (received.length > ANDROID_AUDIO_OUTPUT_ROUTE_ACK_MAGIC.length) {
        finish(new Error(`Invalid Android audio output route ACK length: ${received.length}`));
        return;
      }
      if (received.length === ANDROID_AUDIO_OUTPUT_ROUTE_ACK_MAGIC.length) {
        if (!received.equals(ANDROID_AUDIO_OUTPUT_ROUTE_ACK_MAGIC)) {
          finish(new Error('Invalid Android audio output route ACK'));
          return;
        }
        finish();
      }
    };
    const onClose = () => finish(new Error('Android audio output socket closed before route ACK'));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error('Android audio output route ACK timed out')), timeoutMs);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

export function encodeAndroidAudioPayload(
  samples: Float32Array,
  gain: number,
  format: AndroidAudioOutputFormat,
): Buffer {
  switch (format) {
    case 'f32le':
      return convertFloat32ToF32Le(samples, gain);
    case 's16le':
    default:
      return convertFloat32ToS16Le(samples, gain);
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
    buffer.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), i * 2);
  }
  return buffer;
}

function convertFloat32ToF32Le(samples: Float32Array, gain: number): Buffer {
  const buffer = Buffer.allocUnsafe(samples.length * 4);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, (samples[i] ?? 0) * gain));
    buffer.writeFloatLE(sample, i * 4);
  }
  return buffer;
}
