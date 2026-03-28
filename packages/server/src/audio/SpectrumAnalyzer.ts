import { SpectrumAnalyzer as NativeSpectrumAnalyzer } from 'rubato-fft-node';
import type { SpectrumFrame } from '@tx5dr/contracts';

export interface SpectrumConfig {
  sampleRate: number;
  fftSize: number;
  windowFunction?: 'hann' | 'hamming' | 'blackman' | 'none';
  overlapRatio?: number; // 0.0 - 1.0
  targetSampleRate?: number; // 目标采样率
}

export class SpectrumAnalyzer {
  private config: Required<SpectrumConfig>;
  private nativeAnalyzer: NativeSpectrumAnalyzer;
  private overlapBuffer: Float32Array;
  private overlapSize: number;

  constructor(config: SpectrumConfig) {
    this.config = {
      sampleRate: config.sampleRate,
      fftSize: config.fftSize,
      windowFunction: config.windowFunction || 'hann',
      overlapRatio: config.overlapRatio || 0.5,
      targetSampleRate: config.targetSampleRate || 6000
    };

    // 验证FFT大小是2的幂
    if (!this.isPowerOfTwo(this.config.fftSize)) {
      throw new Error(`FFT size must be a power of 2, got ${this.config.fftSize}`);
    }

    this.overlapSize = Math.floor(this.config.fftSize * this.config.overlapRatio);
    this.overlapBuffer = new Float32Array(this.overlapSize);

    // Map 'none' to 'rectangular' for native analyzer
    const windowFn = this.config.windowFunction === 'none' ? 'rectangular' : this.config.windowFunction;

    this.nativeAnalyzer = new NativeSpectrumAnalyzer(
      this.config.sampleRate,
      this.config.fftSize,
      windowFn,
      this.config.targetSampleRate
    );
  }

  /**
   * 分析音频数据并生成频谱
   */
  async analyze(audioData: Float32Array): Promise<SpectrumFrame> {
    // 首先进行降采样（如需要）
    const processData = this.resampleIfNeeded(audioData);

    // 取最后一个完整的FFT段
    const segment = processData.length >= this.config.fftSize
      ? processData.slice(-this.config.fftSize)
      : processData;

    // 使用原生分析器
    const result = await this.nativeAnalyzer.analyze(segment);

    // 转换为统一 SpectrumFrame 格式
    const freqResolution = this.config.targetSampleRate / this.config.fftSize;
    // Native FFT produces fftSize/2+1 bins (DC to Nyquist inclusive)
    const numBins = result.magnitudesLength;

    return {
      timestamp: Date.now(),
      kind: 'audio',
      frequencyRange: {
        min: 0,
        max: (numBins - 1) * freqResolution
      },
      binaryData: {
        format: {
          type: 'int16' as const,
          length: numBins,
          scale: 1 / result.scale,
          offset: result.offset
        },
        data: result.magnitudesBase64
      },
      meta: {
        sourceBinCount: numBins,
        displayBinCount: numBins,
        centerFrequency: ((numBins - 1) * freqResolution) / 2,
        spanHz: (numBins - 1) * freqResolution,
      },
    };
  }

  /**
   * 如果需要，对输入数据进行降采样
   */
  private resampleIfNeeded(audioData: Float32Array): Float32Array {
    if (this.config.sampleRate === this.config.targetSampleRate) {
      return audioData;
    }

    const ratio = this.config.sampleRate / this.config.targetSampleRate;
    const outputLength = Math.ceil(audioData.length / ratio);
    const paddedLength = Math.ceil(outputLength / this.config.fftSize) * this.config.fftSize;
    const resampled = new Float32Array(paddedLength);

    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = i * ratio;
      const index1 = Math.floor(sourceIndex);
      const index2 = Math.min(index1 + 1, audioData.length - 1);
      const fraction = sourceIndex - index1;

      const sample1 = audioData[index1] || 0;
      const sample2 = audioData[index2] || 0;

      const interpolated = sample1 + (sample2 - sample1) * fraction;
      resampled[i] = Math.max(-1, Math.min(1, interpolated));
    }

    if (outputLength < paddedLength) {
      resampled.fill(0, outputLength);
    }

    return resampled;
  }

  /**
   * 批量分析音频数据（支持重叠处理）
   */
  async analyzeStream(audioData: Float32Array): Promise<SpectrumFrame[]> {
    const results: SpectrumFrame[] = [];
    const hopSize = this.config.fftSize - this.overlapSize;

    for (let i = 0; i <= audioData.length - this.config.fftSize; i += hopSize) {
      const chunk = audioData.slice(i, i + this.config.fftSize);
      const spectrum = await this.analyze(chunk);
      results.push(spectrum);
    }

    return results;
  }

  private isPowerOfTwo(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<SpectrumConfig>): void {
    const oldFftSize = this.config.fftSize;

    Object.assign(this.config, newConfig);

    if (newConfig.fftSize && newConfig.fftSize !== oldFftSize) {
      if (!this.isPowerOfTwo(this.config.fftSize)) {
        throw new Error(`FFT size must be a power of 2, got ${this.config.fftSize}`);
      }
      this.overlapSize = Math.floor(this.config.fftSize * this.config.overlapRatio);
      this.overlapBuffer = new Float32Array(this.overlapSize);
    }

    // Recreate native analyzer with updated config
    if (newConfig.fftSize || newConfig.windowFunction || newConfig.targetSampleRate || newConfig.sampleRate) {
      const windowFn = this.config.windowFunction === 'none' ? 'rectangular' : this.config.windowFunction;
      this.nativeAnalyzer = new NativeSpectrumAnalyzer(
        this.config.sampleRate,
        this.config.fftSize,
        windowFn,
        this.config.targetSampleRate
      );
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): SpectrumConfig {
    return { ...this.config };
  }
}
