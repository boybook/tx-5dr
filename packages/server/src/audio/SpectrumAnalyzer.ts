import FFT from 'fft.js';
import type { FT8Spectrum } from '@tx5dr/contracts';

export interface SpectrumConfig {
  sampleRate: number;
  fftSize: number;
  windowFunction?: 'hann' | 'hamming' | 'blackman' | 'none';
  overlapRatio?: number; // 0.0 - 1.0
  targetSampleRate?: number; // 新增：目标采样率
}

export class SpectrumAnalyzer {
  private config: Required<SpectrumConfig>;
  private fft: FFT;
  private windowFunction: Float32Array;
  private overlapBuffer: Float32Array;
  private overlapSize: number;

  constructor(config: SpectrumConfig) {
    this.config = {
      sampleRate: config.sampleRate,
      fftSize: config.fftSize,
      windowFunction: config.windowFunction || 'hann',
      overlapRatio: config.overlapRatio || 0.5,
      targetSampleRate: config.targetSampleRate || 8000 // 默认降到8kHz
    };

    // 验证FFT大小是2的幂
    if (!this.isPowerOfTwo(this.config.fftSize)) {
      throw new Error(`FFT size must be a power of 2, got ${this.config.fftSize}`);
    }

    this.fft = new FFT(this.config.fftSize);
    this.overlapSize = Math.floor(this.config.fftSize * this.config.overlapRatio);
    this.windowFunction = this.createWindowFunction();
    this.overlapBuffer = new Float32Array(this.overlapSize);
  }

  /**
   * 分析音频数据并生成频谱
   */
  analyze(audioData: Float32Array): FT8Spectrum {
    // 首先进行降采样
    const resampledData = this.resampleIfNeeded(audioData);
    
    // 确保数据长度是FFT大小的整数倍
    const numSegments = Math.floor(resampledData.length / this.config.fftSize);
    const processLength = numSegments * this.config.fftSize;
    
    // 取最后一个完整的FFT段
    const processData = resampledData.slice(-this.config.fftSize);

    // 应用窗口函数
    const windowedData = this.applyWindow(processData);

    // 创建输出数组
    const output = this.fft.createComplexArray();

    // 执行实数FFT（更高效）
    this.fft.realTransform(output, Array.from(windowedData));

    // 计算幅度谱
    const magnitudes = this.calculateMagnitudes(output);

    // 转换为dB
    const magnitudesDB = this.convertToDecibels(magnitudes);

    // 生成FT8频谱数据
    return this.createFT8Spectrum(magnitudesDB);
  }

  /**
   * 如果需要，对输入数据进行降采样
   */
  private resampleIfNeeded(audioData: Float32Array): Float32Array {
    if (this.config.sampleRate === this.config.targetSampleRate) {
      return audioData;
    }

    // 计算降采样后需要的点数，确保是FFT_SIZE的整数倍
    const ratio = this.config.sampleRate / this.config.targetSampleRate;
    const outputLength = Math.ceil(audioData.length / ratio);
    const paddedLength = Math.ceil(outputLength / this.config.fftSize) * this.config.fftSize;
    const resampled = new Float32Array(paddedLength);
    
    // 使用线性插值进行降采样
    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = i * ratio;
      const index1 = Math.floor(sourceIndex);
      const index2 = Math.min(index1 + 1, audioData.length - 1);
      const fraction = sourceIndex - index1;
      
      const sample1 = audioData[index1] || 0;
      const sample2 = audioData[index2] || 0;
      
      // 线性插值
      const interpolated = sample1 + (sample2 - sample1) * fraction;
      
      // 防止爆音：限制到有效范围
      resampled[i] = Math.max(-1, Math.min(1, interpolated));
    }

    // 如果需要，用0填充剩余部分
    if (outputLength < paddedLength) {
      resampled.fill(0, outputLength);
    }
    
    return resampled;
  }

  /**
   * 批量分析音频数据（支持重叠处理）
   */
  analyzeStream(audioData: Float32Array): FT8Spectrum[] {
    const results: FT8Spectrum[] = [];
    const hopSize = this.config.fftSize - this.overlapSize;
    
    for (let i = 0; i <= audioData.length - this.config.fftSize; i += hopSize) {
      const chunk = audioData.slice(i, i + this.config.fftSize);
      const spectrum = this.analyze(chunk);
      results.push(spectrum);
    }

    return results;
  }

  /**
   * 检查是否为2的幂
   */
  private isPowerOfTwo(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
  }

  /**
   * 创建窗口函数
   */
  private createWindowFunction(): Float32Array {
    const size = this.config.fftSize;
    const window = new Float32Array(size);

    switch (this.config.windowFunction) {
      case 'hann':
        for (let i = 0; i < size; i++) {
          window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
        }
        break;

      case 'hamming':
        for (let i = 0; i < size; i++) {
          window[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
        }
        break;

      case 'blackman':
        for (let i = 0; i < size; i++) {
          const a0 = 0.42;
          const a1 = 0.5;
          const a2 = 0.08;
          window[i] = a0 - a1 * Math.cos(2 * Math.PI * i / (size - 1)) + 
                     a2 * Math.cos(4 * Math.PI * i / (size - 1));
        }
        break;

      case 'none':
      default:
        window.fill(1.0);
        break;
    }

    return window;
  }

  /**
   * 应用窗口函数
   */
  private applyWindow(data: Float32Array): Float32Array {
    const windowed = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const windowValue = this.windowFunction[i] ?? 1.0;
      const dataValue = data[i] ?? 0;
      windowed[i] = dataValue * windowValue;
    }
    return windowed;
  }

  /**
   * 计算FFT结果的幅度（fft.js使用交错复数格式）
   */
  private calculateMagnitudes(complexArray: number[]): Float32Array {
    const numBins = complexArray.length / 2; // 复数数组长度是实际频率bin数的2倍
    const magnitudes = new Float32Array(numBins);
    
    for (let i = 0; i < numBins; i++) {
      const real = complexArray[i * 2] ?? 0;
      const imag = complexArray[i * 2 + 1] ?? 0;
      magnitudes[i] = Math.sqrt(real * real + imag * imag);
    }

    return magnitudes;
  }

  /**
   * 转换为分贝
   */
  private convertToDecibels(magnitudes: Float32Array): Float32Array {
    const db = new Float32Array(magnitudes.length);
    const reference = 1.0; // 参考值

    for (let i = 0; i < magnitudes.length; i++) {
      // 避免log(0)，设置最小值
      const magnitude = Math.max(magnitudes[i] ?? 0, 1e-10);
      db[i] = 20 * Math.log10(magnitude / reference);
    }

    return db;
  }

  /**
   * 创建FT8频谱数据（匹配contracts中的FT8Spectrum接口）
   */
  private createFT8Spectrum(magnitudes: Float32Array): FT8Spectrum {
    // 计算频率分辨率
    const freqResolution = this.config.targetSampleRate / this.config.fftSize;
    
    // 使用FFT结果的前半部分（因为是实数FFT）
    const numPoints = Math.floor(this.config.fftSize / 2);
    
    // 提取需要的频谱数据
    const ft8Magnitudes = magnitudes.slice(0, numPoints);

    // 将Float32Array转换为Int16Array
    const int16Data = new Int16Array(ft8Magnitudes.length);
    const minDb = -120;
    const maxDb = 0;
    const scale = 32767 / (maxDb - minDb); // 缩放因子

    let sumDb = 0;
    let peakDb = minDb;
    let peakIndex = 0;

    for (let i = 0; i < ft8Magnitudes.length; i++) {
      // 将dB值限制在范围内并缩放到Int16范围
      const db = Math.max(minDb, Math.min(maxDb, ft8Magnitudes[i] || minDb));
      int16Data[i] = Math.round((db - minDb) * scale);
      
      // 计算统计信息
      sumDb += db;
      if (db > peakDb) {
        peakDb = db;
        peakIndex = i;
      }
    }

    // 计算峰值频率
    const peakFrequency = peakIndex * freqResolution;

    // 将Int16Array转换为base64字符串
    const base64Data = Buffer.from(int16Data.buffer).toString('base64');

    return {
      timestamp: Date.now(),
      sampleRate: this.config.targetSampleRate,
      frequencyRange: {
        min: 0,
        max: (numPoints - 1) * freqResolution // 实际频率范围
      },
      binaryData: {
        format: {
          type: 'int16' as const,
          length: int16Data.length,
          scale: 1 / scale,
          offset: minDb
        },
        data: base64Data
      },
      summary: {
        peakFrequency,
        peakMagnitude: peakDb,
        averageMagnitude: sumDb / ft8Magnitudes.length,
        dynamicRange: peakDb - minDb
      }
    };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<SpectrumConfig>): void {
    const oldFftSize = this.config.fftSize;
    
    Object.assign(this.config, newConfig);

    // 如果FFT大小改变，重新初始化
    if (newConfig.fftSize && newConfig.fftSize !== oldFftSize) {
      if (!this.isPowerOfTwo(this.config.fftSize)) {
        throw new Error(`FFT size must be a power of 2, got ${this.config.fftSize}`);
      }
      this.fft = new FFT(this.config.fftSize);
      this.overlapSize = Math.floor(this.config.fftSize * this.config.overlapRatio);
      this.windowFunction = this.createWindowFunction();
      this.overlapBuffer = new Float32Array(this.overlapSize);
    }

    // 如果窗口函数改变，重新创建
    if (newConfig.windowFunction) {
      this.windowFunction = this.createWindowFunction();
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): SpectrumConfig {
    return { ...this.config };
  }
} 