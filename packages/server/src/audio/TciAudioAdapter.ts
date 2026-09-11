import { EventEmitter } from 'eventemitter3';
import { TciConnection, type PreparedTciAudioTransmission } from '../radio/connections/TciConnection.js';
import type { AudioFrameMeta } from '../radio/connections/IRadioConnection.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TciAudioAdapter');

export interface TciAudioAdapterEvents {
  audioData: (samples: Float32Array, meta?: AudioFrameMeta) => void;
  error: (error: Error) => void;
}

/**
 * TCI audio adapter for SunSDR/ExpertSDR.
 * It keeps the app-facing path identical to the ICOM WLAN adapter: RX frames
 * arrive as canonical Float32 samples, and TX Float32 chunks are sent as TCI audio.
 */
export class TciAudioAdapter extends EventEmitter<TciAudioAdapterEvents> {
  private readonly handleAudioFrameBound = (samples: Float32Array, meta?: AudioFrameMeta) => this.handleAudioFrame(samples, meta);
  private readonly handleErrorBound = (error: Error) => this.emit('error', error);
  private isReceiving = false;

  constructor(private readonly tciConnection: TciConnection) {
    super();
    logger.info(`Initialized with TCI audio sample rate ${this.getSampleRate()}Hz`);
  }

  startReceiving(): void {
    if (this.isReceiving) {
      logger.warn('Already receiving TCI audio');
      return;
    }

    this.tciConnection.on('audioFrame', this.handleAudioFrameBound);
    this.tciConnection.on('error', this.handleErrorBound);
    const start = this.tciConnection.supportsNativeLineOutStream?.()
      ? this.tciConnection.startLineOutStream!.bind(this.tciConnection)
      : () => this.tciConnection.startAudioStream('rx-input');
    void Promise.resolve(start()).catch((error) => {
      logger.error('Failed to start TCI audio stream', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
    this.isReceiving = true;
    logger.info('TCI audio reception started');
  }

  stopReceiving(): void {
    if (!this.isReceiving) {
      return;
    }

    this.tciConnection.off('audioFrame', this.handleAudioFrameBound);
    this.tciConnection.off('error', this.handleErrorBound);
    const stop = this.tciConnection.supportsNativeLineOutStream?.()
      ? this.tciConnection.stopLineOutStream!.bind(this.tciConnection)
      : () => this.tciConnection.stopAudioStream('rx-input');
    void Promise.resolve(stop()).catch((error) => {
      logger.debug('Failed to stop TCI audio stream', error);
    });
    this.isReceiving = false;
    logger.info('TCI audio reception stopped');
  }

  async startOutput(): Promise<void> {
    await this.tciConnection.startAudioStream('tx-output');
  }

  async stopOutput(): Promise<void> {
    await this.tciConnection.stopAudioStream('tx-output');
  }

  async beginTransmission(): Promise<void> {
    await this.startOutput();
    this.tciConnection.beginTxAudio();
  }

  async beginPreparedTransmission(samples: Float32Array, sampleRate: number, onConsumed: (samples: number) => void): Promise<PreparedTciAudioTransmission> {
    await this.startOutput();
    return this.tciConnection.beginPreparedTxAudio(samples, sampleRate, onConsumed);
  }

  async drainTransmission(timeoutMs: number): Promise<void> {
    await this.tciConnection.waitForTxAudioDrain(timeoutMs);
  }

  async endTransmission(): Promise<void> {
    this.tciConnection.endTxAudio();
  }

  async sendAudio(samples: Float32Array): Promise<void> {
    try {
      await this.tciConnection.sendAudio(samples);
    } catch (error) {
      logger.error('Failed to send TCI audio', error);
      throw error;
    }
  }

  isReceivingAudio(): boolean {
    return this.isReceiving;
  }

  getSampleRate(): number {
    return this.tciConnection.getAudioSampleRate();
  }

  getTxAudioSyncSnapshot() {
    return this.tciConnection.getTxAudioSyncSnapshot?.() ?? null;
  }

  private handleAudioFrame(samples: Float32Array, meta?: AudioFrameMeta): void {
    try {
      this.emit('audioData', samples, meta);
    } catch (error) {
      logger.error('Failed to process TCI audio frame', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

}
