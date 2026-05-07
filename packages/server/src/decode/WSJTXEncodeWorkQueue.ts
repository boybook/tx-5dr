import { EventEmitter } from 'eventemitter3';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EncodeWorkQueue');

function normalizeMessageForEncodeCheck(message: string): string {
  return message.trim().toUpperCase().replace(/\s+/g, ' ');
}

export interface EncodeRequest {
  message: string;
  frequency: number;
  operatorId: string;
  mode?: 'FT8' | 'FT4';
  slotStartMs?: number; // 时隙开始时间戳
  timeSinceSlotStartMs?: number; // 从时隙开始到现在经过的时间（毫秒）
  requestId?: string; // 编码请求唯一ID（用于去重和追踪）
}

export interface EncodeResult {
  operatorId: string;
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  encodeFrequencyHz: number;
  rawEncodeSampleRate: number;
  rawEncodeSpectrum: EncodeAudioSpectrumSummary;
  resampledSpectrum: EncodeAudioSpectrumSummary;
  success: boolean;
  error?: string;
}

export interface EncodeAudioSpectrumSummary {
  sampleRate: number;
  segmentStartMs: number;
  segmentDurationMs: number;
  dominantFrequencyHz: number | null;
  zeroCrossingFrequencyHz: number | null;
  topFrequenciesHz: number[];
  peak: number;
  rms: number;
}

export interface EncodeWorkQueueEvents {
  'encodeComplete': (result: EncodeResult) => void;
  'encodeError': (error: Error, request: EncodeRequest) => void;
  'queueEmpty': () => void;
}

/**
 * 使用 wsjtx-lib 进行FT8消息编码
 */
export class WSJTXEncodeWorkQueue extends EventEmitter<EncodeWorkQueueEvents> {
  private queueSize = 0;
  private maxConcurrency: number;
  private lib: WSJTXLib;
  
  constructor(maxConcurrency: number = 2) {
    super();
    this.maxConcurrency = maxConcurrency;
    this.lib = new WSJTXLib({ maxThreads: 4 });
    logger.info('encode work queue initialized', { maxConcurrency });
  }

  private computeAudioStats(samples: Float32Array): { peak: number; rms: number } {
    if (samples.length === 0) {
      return { peak: 0, rms: 0 };
    }

    let peak = 0;
    let sumSquares = 0;
    for (const sample of samples) {
      const abs = Math.abs(sample);
      if (abs > peak) {
        peak = abs;
      }
      sumSquares += sample * sample;
    }
    return { peak, rms: Math.sqrt(sumSquares / samples.length) };
  }

  private selectAnalysisSegment(samples: Float32Array, sampleRate: number): { segment: Float32Array; start: number } {
    const segmentLength = Math.min(samples.length, Math.max(2048, Math.min(8192, Math.floor(sampleRate * 0.5))));
    if (samples.length <= segmentLength) {
      return { segment: samples, start: 0 };
    }

    const candidateCount = 16;
    let bestStart = 0;
    let bestEnergy = -1;
    for (let candidate = 0; candidate < candidateCount; candidate++) {
      const start = Math.floor((candidate / Math.max(1, candidateCount - 1)) * (samples.length - segmentLength));
      let energy = 0;
      for (let i = 0; i < segmentLength; i++) {
        const sample = samples[start + i] ?? 0;
        energy += sample * sample;
      }
      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestStart = start;
      }
    }

    return { segment: samples.subarray(bestStart, bestStart + segmentLength), start: bestStart };
  }

  private estimateZeroCrossingFrequency(samples: Float32Array, sampleRate: number): number | null {
    if (samples.length < 2) {
      return null;
    }

    let crossings = 0;
    let previous = samples[0] >= 0;
    for (let i = 1; i < samples.length; i++) {
      const current = samples[i] >= 0;
      if (current !== previous) {
        crossings++;
        previous = current;
      }
    }

    const durationSec = samples.length / sampleRate;
    return durationSec > 0 ? crossings / (2 * durationSec) : null;
  }

  private goertzelPower(samples: Float32Array, sampleRate: number, frequencyHz: number, mean: number): number {
    const omega = (2 * Math.PI * frequencyHz) / sampleRate;
    const coeff = 2 * Math.cos(omega);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;

    for (let i = 0; i < samples.length; i++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, samples.length - 1));
      s0 = (samples[i] - mean) * window + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }

    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  private estimateDominantFrequencies(samples: Float32Array, sampleRate: number): number[] {
    if (samples.length < 16) {
      return [];
    }

    let mean = 0;
    for (const sample of samples) {
      mean += sample;
    }
    mean /= samples.length;

    const maxFrequency = Math.min(4000, Math.floor(sampleRate / 2 - 1));
    const coarse: Array<{ frequency: number; power: number }> = [];

    for (let frequency = 1; frequency <= Math.min(100, maxFrequency); frequency += 1) {
      coarse.push({ frequency, power: this.goertzelPower(samples, sampleRate, frequency, mean) });
    }
    for (let frequency = 105; frequency <= maxFrequency; frequency += 5) {
      coarse.push({ frequency, power: this.goertzelPower(samples, sampleRate, frequency, mean) });
    }

    coarse.sort((a, b) => b.power - a.power);
    const refined = new Map<number, number>();
    for (const candidate of coarse.slice(0, 8)) {
      const from = Math.max(1, Math.round(candidate.frequency - 6));
      const to = Math.min(maxFrequency, Math.round(candidate.frequency + 6));
      for (let frequency = from; frequency <= to; frequency += 1) {
        if (!refined.has(frequency)) {
          refined.set(frequency, this.goertzelPower(samples, sampleRate, frequency, mean));
        }
      }
    }

    return Array.from(refined.entries())
      .map(([frequency, power]) => ({ frequency, power }))
      .sort((a, b) => b.power - a.power)
      .slice(0, 8)
      .map(({ frequency }) => frequency);
  }

  private summarizeSpectrum(samples: Float32Array, sampleRate: number): EncodeAudioSpectrumSummary {
    const { segment, start } = this.selectAnalysisSegment(samples, sampleRate);
    const stats = this.computeAudioStats(segment);
    const topFrequenciesHz = this.estimateDominantFrequencies(segment, sampleRate);
    const zeroCrossingFrequencyHz = this.estimateZeroCrossingFrequency(segment, sampleRate);

    return {
      sampleRate,
      segmentStartMs: Math.round((start / sampleRate) * 1000),
      segmentDurationMs: Math.round((segment.length / sampleRate) * 1000),
      dominantFrequencyHz: topFrequenciesHz[0] ?? null,
      zeroCrossingFrequencyHz: zeroCrossingFrequencyHz !== null
        ? Number(zeroCrossingFrequencyHz.toFixed(1))
        : null,
      topFrequenciesHz,
      peak: Number(stats.peak.toFixed(6)),
      rms: Number(stats.rms.toFixed(6)),
    };
  }
  
  /**
   * 推送编码请求到队列
   */
  async push(request: EncodeRequest): Promise<void> {
    this.queueSize++;
    
    logger.debug('encode request received', {
      operatorId: request.operatorId,
      message: request.message,
      frequency: request.frequency,
      mode: request.mode || 'FT8',
      timeSinceSlotStartMs: request.timeSinceSlotStartMs,
      queueSize: this.queueSize,
    });
    
    try {
      const startTime = performance.now();

      // 确定模式
      const mode = request.mode === 'FT4' ? WSJTXMode.FT4 : WSJTXMode.FT8;
      if (request.frequency < 200 || request.frequency > 3000) {
        logger.warn('encode request frequency outside normal FT8 audio passband', {
          operatorId: request.operatorId,
          requestId: request.requestId,
          frequency: request.frequency,
          mode: request.mode || 'FT8',
        });
      }

      // 调用原生库编码
      const { audioData: audioFloat32, messageSent } = await this.lib.encode(
        mode,
        request.message,
        request.frequency
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

      // 基于模式校验并必要时截断
      const expectedDuration = mode === WSJTXMode.FT8 ? 12.64 : 6.0;
      const encodeSampleRate = 48000; // wsjtx-lib 编码输出为 48kHz
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
      const rawEncodeSpectrum = this.summarizeSpectrum(finalAudio, encodeSampleRate);

      // 重采样到统一的内部采样率（12kHz）
      const INTERNAL_SAMPLE_RATE = 12000;
      logger.debug(`resampling: ${encodeSampleRate}Hz -> ${INTERNAL_SAMPLE_RATE}Hz`);
      finalAudio = await resampleAudioProfessional(
        finalAudio,
        encodeSampleRate,
        INTERNAL_SAMPLE_RATE,
        1 // 单声道
      );
      const resampledSpectrum = this.summarizeSpectrum(finalAudio, INTERNAL_SAMPLE_RATE);

      // 统计振幅范围
      let minSample = finalAudio[0];
      let maxSample = finalAudio[0];
      let maxAmplitude = 0;
      for (let i = 0; i < finalAudio.length; i++) {
        const s = finalAudio[i];
        if (s < minSample) minSample = s;
        if (s > maxSample) maxSample = s;
        const a = Math.abs(s);
        if (a > maxAmplitude) maxAmplitude = a;
      }

      // 输出采样率固定为 12kHz（统一内部采样率）
      const sampleRate = INTERNAL_SAMPLE_RATE;
      const duration = finalAudio.length / sampleRate;
      const processingTimeMs = performance.now() - startTime;

      logger.debug('encode complete', {
        operatorId: request.operatorId,
        frequency: request.frequency,
        duration: `${duration.toFixed(2)}s`,
        amplitude: `[${minSample.toFixed(4)}, ${maxSample.toFixed(4)}]`,
        processingTimeMs: processingTimeMs.toFixed(2),
      });
      logger.info('encode audio frequency diagnostics', {
        operatorId: request.operatorId,
        requestId: request.requestId,
        requestedFrequencyHz: request.frequency,
        mode: request.mode || 'FT8',
        rawEncodeSpectrum,
        resampledSpectrum,
      });

      const encodeResult: EncodeResult & { request?: EncodeRequest } = {
        operatorId: request.operatorId,
        audioData: finalAudio,
        sampleRate,
        duration,
        encodeFrequencyHz: request.frequency,
        rawEncodeSampleRate: encodeSampleRate,
        rawEncodeSpectrum,
        resampledSpectrum,
        success: true,
        request
      };

      this.emit('encodeComplete', encodeResult);
      if (this.queueSize === 0) this.emit('queueEmpty');

    } catch (error) {
      logger.error('encode failed', { operatorId: request.operatorId, error });
      this.emit('encodeError', error as Error, request);
      if (this.queueSize === 0) this.emit('queueEmpty');
    } finally {
      if (this.queueSize > 0) this.queueSize--;
    }
  }
  
  /**
   * 获取队列大小
   */
  size(): number {
    return this.queueSize;
  }
  
  /**
   * 获取工作池状态
   */
  getStatus() {
    return {
      queueSize: this.queueSize,
      maxConcurrency: this.maxConcurrency,
      activeThreads: 0,
      utilization: 0
    };
  }
  
  /**
   * 销毁工作池
   */
  async destroy(): Promise<void> {
    logger.info('encode work queue destroyed (main thread, no worker pool)');
  }
}
