import net from 'node:net';
import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../utils/logger.js';
import type { AndroidAudioDeviceDescriptor } from './android-audio-devices.js';

const logger = createLogger('AndroidAudioSocketBackend');

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

  write(samples: Float32Array, gain = 1): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    return this.socket.write(convertFloat32ToS16Le(samples, gain));
  }
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
