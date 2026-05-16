import { EventEmitter } from 'eventemitter3';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';
import { WSJTXNativeGate } from './WSJTXNativeGate.js';

const logger = createLogger('EncodeWorkQueue');

function normalizeMessageForEncodeCheck(message: string): string {
  return message.trim().toUpperCase().replace(/\s+/g, ' ');
}

export interface EncodeRequest {
  message: string;
  frequency: number;
  operatorId: string;
  mode?: 'FT8' | 'FT4' | 'MSK144';
  slotStartMs?: number;
  timeSinceSlotStartMs?: number;
  requestId?: string;
}

export interface EncodeResult {
  operatorId: string;
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  success: boolean;
  error?: string;
}

export interface EncodeWorkQueueEvents {
  encodeComplete: (result: EncodeResult) => void;
  encodeError: (error: Error, request: EncodeRequest) => void;
  queueEmpty: () => void;
}

const EXPECTED_DURATION_SECONDS_BY_MODE: Record<NonNullable<EncodeRequest['mode']>, number> = {
  FT8: 12.64,
  FT4: 6.0,
  MSK144: 15.0,
};

function resolveNativeMode(mode: EncodeRequest['mode']): number {
  const normalized = mode?.toUpperCase() ?? 'FT8';
  const nativeModes = WSJTXMode as unknown as Record<string, number>;
  if (normalized === 'FT4') return nativeModes.FT4;
  if (normalized === 'MSK144') {
    if (typeof nativeModes.MSK144 !== 'number') {
      throw new Error('wsjtx-lib does not expose WSJTXMode.MSK144');
    }
    return nativeModes.MSK144;
  }
  return nativeModes.FT8;
}

/**
 * Encode queue backed by wsjtx-lib.
 */
export class WSJTXEncodeWorkQueue extends EventEmitter<EncodeWorkQueueEvents> {
  private readonly maxConcurrency: number;
  private readonly lib: WSJTXLib;
  private activeCount = 0;
  private readonly pending: Array<{
    request: EncodeRequest;
    resolve: () => void;
  }> = [];

  constructor(maxConcurrency: number = 2) {
    super();
    this.maxConcurrency = Number.isFinite(maxConcurrency)
      ? Math.max(1, Math.floor(maxConcurrency))
      : 1;
    this.lib = new WSJTXLib({ maxThreads: 4 });
    logger.info('encode work queue initialized', { maxConcurrency: this.maxConcurrency });
  }

  async push(request: EncodeRequest): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push({ request, resolve });
      logger.debug('encode request queued', {
        operatorId: request.operatorId,
        message: request.message,
        frequency: request.frequency,
        mode: request.mode || 'FT8',
        timeSinceSlotStartMs: request.timeSinceSlotStartMs,
        queueSize: this.size(),
      });
      this.processQueue();
    });
  }

  private processQueue(): void {
    while (this.activeCount < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.activeCount++;
      void this.processItem(item.request)
        .finally(() => {
          this.activeCount--;
          item.resolve();
          if (this.size() === 0) {
            this.emit('queueEmpty');
          }
          this.processQueue();
        });
    }
  }

  private async processItem(request: EncodeRequest): Promise<void> {
    try {
      const startTime = performance.now();
      const modeName: NonNullable<EncodeRequest['mode']> = request.mode ?? 'FT8';
      const nativeMode = resolveNativeMode(modeName);

      logger.debug('encode start', {
        operatorId: request.operatorId,
        mode: modeName,
        frequency: request.frequency,
      });

      const { audioData: audioFloat32, messageSent } = await WSJTXNativeGate.run(
        () => this.lib.encode(nativeMode, request.message, request.frequency),
      );

      const normalizedRequestedMessage = normalizeMessageForEncodeCheck(request.message);
      const normalizedSentMessage = normalizeMessageForEncodeCheck(messageSent ?? '');
      if (normalizedSentMessage !== normalizedRequestedMessage) {
        throw new Error(
          `encoder changed message text: requested="${normalizedRequestedMessage}", sent="${normalizedSentMessage}". `
          + 'Free text messages are limited to 13 characters by WSJT-X.',
        );
      }

      if (!audioFloat32 || audioFloat32.length === 0) {
        throw new Error('encode returned empty audio data');
      }

      const expectedDuration = EXPECTED_DURATION_SECONDS_BY_MODE[modeName];
      const encodeSampleRate = 48000;
      const actualDuration = audioFloat32.length / encodeSampleRate;
      const maxSamples = Math.floor(expectedDuration * encodeSampleRate * 1.5);
      let finalAudio = audioFloat32;
      if (finalAudio.length > maxSamples) {
        logger.warn(`audio too long, truncating ${finalAudio.length} -> ${maxSamples}`);
        finalAudio = finalAudio.slice(0, maxSamples);
      }
      if (Math.abs(actualDuration - expectedDuration) > 2 && actualDuration > expectedDuration * 2) {
        const expectedSamples = Math.floor(expectedDuration * encodeSampleRate);
        logger.debug(`truncating to expected length: ${expectedSamples}`);
        finalAudio = finalAudio.slice(0, expectedSamples);
      }

      const INTERNAL_SAMPLE_RATE = 12000;
      logger.debug(`resampling: ${encodeSampleRate}Hz -> ${INTERNAL_SAMPLE_RATE}Hz`);
      finalAudio = await resampleAudioProfessional(
        finalAudio,
        encodeSampleRate,
        INTERNAL_SAMPLE_RATE,
        1,
      );

      let minSample = finalAudio[0];
      let maxSample = finalAudio[0];
      for (let i = 1; i < finalAudio.length; i += 1) {
        const sample = finalAudio[i];
        if (sample < minSample) minSample = sample;
        if (sample > maxSample) maxSample = sample;
      }

      const sampleRate = INTERNAL_SAMPLE_RATE;
      const duration = finalAudio.length / sampleRate;
      const processingTimeMs = performance.now() - startTime;

      logger.debug('encode complete', {
        operatorId: request.operatorId,
        mode: modeName,
        duration: `${duration.toFixed(2)}s`,
        amplitude: `[${minSample.toFixed(4)}, ${maxSample.toFixed(4)}]`,
        processingTimeMs: processingTimeMs.toFixed(2),
      });

      const encodeResult: EncodeResult & { request?: EncodeRequest } = {
        operatorId: request.operatorId,
        audioData: finalAudio,
        sampleRate,
        duration,
        success: true,
        request,
      };

      this.emit('encodeComplete', encodeResult);
    } catch (error) {
      logger.error('encode failed', {
        operatorId: request.operatorId,
        mode: request.mode ?? 'FT8',
        error,
      });
      this.emit('encodeError', error as Error, request);
    }
  }

  size(): number {
    return this.pending.length + this.activeCount;
  }

  getStatus() {
    return {
      queueSize: this.size(),
      maxConcurrency: this.maxConcurrency,
      activeThreads: this.activeCount,
      utilization: this.activeCount / this.maxConcurrency,
    };
  }

  async destroy(): Promise<void> {
    this.pending.splice(0).forEach((item) => item.resolve());
    logger.info('encode work queue destroyed (main thread)', {
      activeCount: this.activeCount,
    });
  }
}
