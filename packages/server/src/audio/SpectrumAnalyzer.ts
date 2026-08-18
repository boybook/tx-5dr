import { SpectrumAnalyzer as NativeSpectrumAnalyzer } from 'rubato-fft-node';
import type { SpectrumFrame } from '@tx5dr/contracts';

export interface SpectrumConfig {
  sampleRate: number;
  fftSize: number;
  windowFunction?: 'hann' | 'hamming' | 'blackman' | 'none';
  overlapRatio?: number; // 0.0 - 1.0
  targetSampleRate?: number; // 目标采样率
  /**
   * Display-only frequency-domain baseline flattening for IF-mode audio waterfalls.
   * Removes the colored/tilted noise-floor "halo" cloud so only real above-noise
   * signal keeps its color, JTDX-style. The decode path is never touched.
   */
  haloReduce?: boolean;
}

export class SpectrumAnalyzer {
  private config: Required<SpectrumConfig>;
  private nativeAnalyzer: NativeSpectrumAnalyzer;
  private overlapBuffer: Float32Array;
  private overlapSize: number;
  /** Rolling history at targetSampleRate so short scheduler chunks still fill one FFT window. */
  private rollingTarget: Float32Array;
  private rollingWrite = 0;
  private rollingCount = 0;

  constructor(config: SpectrumConfig) {
    this.config = {
      sampleRate: config.sampleRate,
      fftSize: config.fftSize,
      windowFunction: config.windowFunction || 'hann',
      overlapRatio: config.overlapRatio || 0.5,
      targetSampleRate: config.targetSampleRate || 6000,
      haloReduce: config.haloReduce ?? false,
    };

    // 验证FFT大小是2的幂
    if (!this.isPowerOfTwo(this.config.fftSize)) {
      throw new Error(`FFT size must be a power of 2, got ${this.config.fftSize}`);
    }

    this.overlapSize = Math.floor(this.config.fftSize * this.config.overlapRatio);
    this.overlapBuffer = new Float32Array(this.overlapSize);
    this.rollingTarget = new Float32Array(this.config.fftSize);

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

    // IF (haloReduce): rolling FFT window avoids short-chunk zero-pad bricks.
    // AF: keep the author's original short-segment / zero-pad path.
    let segment: Float32Array;
    if (this.config.haloReduce) {
      this.appendToRollingTarget(processData);
      segment = this.readRollingTargetWindow();
    } else {
      segment = processData.length >= this.config.fftSize
        ? processData.slice(-this.config.fftSize)
        : processData;
    }

    // 使用原生分析器
    const result = await this.nativeAnalyzer.analyze(segment);

    // 转换为统一 SpectrumFrame 格式
    const freqResolution = this.config.targetSampleRate / this.config.fftSize;
    // Native FFT produces fftSize/2+1 bins (DC to Nyquist inclusive)
    const numBins = result.magnitudesLength;
    const scale = 1 / result.scale;
    const offset = result.offset;
    let magnitudesBase64 = result.magnitudesBase64;

    if (this.config.haloReduce && numBins > 0) {
      magnitudesBase64 = this.applyBaselineFlatten(magnitudesBase64, numBins, scale, offset);
    }

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
          scale,
          offset,
        },
        data: magnitudesBase64
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
   * Frequency-domain baseline flattening for IF-mode audio waterfalls (display only).
   *
   * The raw IF path carries a colored/tilted noise floor (analog front-end + demod
   * shape), which the palette renders as a diffuse "halo" cloud around strong FT8
   * traces. WSJT-X-style flattening estimates a robust per-bin noise baseline and
   * subtracts its shape, so the background collapses onto a single uniform floor and
   * only true above-noise signal energy keeps its color. It never amplifies signal
   * and never touches the decode path.
   */
  private applyBaselineFlatten(
    magnitudesBase64: string,
    numBins: number,
    scale: number,
    offset: number,
  ): string {
    const buffer = Buffer.from(magnitudesBase64, 'base64');
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, Math.min(numBins, buffer.byteLength / 2));
    const n = int16.length;
    if (n < 32) {
      return magnitudesBase64;
    }

    const db = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      db[i] = int16[i] * scale + offset;
    }

    // 1) Robust local noise floor per block. A low percentile ignores the few signal
    //    bins in each block; blockSize (~64 bins) is far wider than one FT8 signal
    //    (~17 bins), so genuine signals never define their own baseline.
    const blockSize = 64;
    const floorPercentile = 0.3;
    const numBlocks = Math.ceil(n / blockSize);
    const blockFloor = new Float32Array(numBlocks);
    const blockCenter = new Float32Array(numBlocks);
    const scratch: number[] = [];
    for (let b = 0; b < numBlocks; b++) {
      const start = b * blockSize;
      const end = Math.min(start + blockSize, n);
      scratch.length = 0;
      for (let i = start; i < end; i++) {
        scratch.push(db[i]);
      }
      scratch.sort((a, c) => a - c);
      const idx = Math.min(scratch.length - 1, Math.floor(scratch.length * floorPercentile));
      blockFloor[b] = scratch[idx];
      blockCenter[b] = (start + end - 1) / 2;
    }

    // 2) One representative flat floor: the median block floor is stable even if a
    //    few blocks are dominated by strong signals.
    const sortedFloors = Array.from(blockFloor).sort((a, c) => a - c);
    const flatFloor = sortedFloors[Math.floor(sortedFloors.length / 2)];

    // 3) Flatten: out = flatFloor + (db - baseline), where baseline is the block-floor
    //    curve linearly interpolated across bins. Background collapses onto flatFloor;
    //    real signals keep their above-noise margin. The residual's low side is gently
    //    clamped so background noise renders uniform (no dark speckle).
    let b = 0;
    for (let i = 0; i < n; i++) {
      while (b < numBlocks - 2 && blockCenter[b + 1] <= i) {
        b++;
      }
      let baseline: number;
      if (i <= blockCenter[0]) {
        baseline = blockFloor[0];
      } else if (i >= blockCenter[numBlocks - 1]) {
        baseline = blockFloor[numBlocks - 1];
      } else {
        const c0 = blockCenter[b];
        const c1 = blockCenter[b + 1];
        const t = (i - c0) / (c1 - c0);
        baseline = blockFloor[b] + (blockFloor[b + 1] - blockFloor[b]) * t;
      }
      const residual = db[i] - baseline;
      db[i] = flatFloor + Math.max(residual, -2);
    }

    for (let i = 0; i < n; i++) {
      const quantized = Math.round((db[i] - offset) / scale);
      int16[i] = Math.max(-32768, Math.min(32767, quantized));
    }

    return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');
  }

  /**
   * 如果需要，对输入数据进行降采样。
   * AF（作者原路径）: 短块零填充到 fftSize 整数倍。
   * IF（haloReduce）: 不零填充，由 rolling buffer 攒满一整窗。
   */
  private resampleIfNeeded(audioData: Float32Array): Float32Array {
    if (this.config.sampleRate === this.config.targetSampleRate) {
      return audioData;
    }

    const ratio = this.config.sampleRate / this.config.targetSampleRate;
    const outputLength = Math.ceil(audioData.length / ratio);
    const paddedLength = this.config.haloReduce
      ? outputLength
      : Math.ceil(outputLength / this.config.fftSize) * this.config.fftSize;
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

  private appendToRollingTarget(samples: Float32Array): void {
    if (samples.length === 0) {
      return;
    }
    const size = this.rollingTarget.length;
    if (samples.length >= size) {
      this.rollingTarget.set(samples.subarray(samples.length - size));
      this.rollingWrite = 0;
      this.rollingCount = size;
      return;
    }
    for (let i = 0; i < samples.length; i++) {
      this.rollingTarget[this.rollingWrite] = samples[i];
      this.rollingWrite = (this.rollingWrite + 1) % size;
      if (this.rollingCount < size) {
        this.rollingCount += 1;
      }
    }
  }

  private readRollingTargetWindow(): Float32Array {
    const size = this.config.fftSize;
    const segment = new Float32Array(size);
    if (this.rollingCount <= 0) {
      return segment;
    }
    if (this.rollingCount < size) {
      // Keep live audio at the end of the window so the taper does not erase it.
      const start = size - this.rollingCount;
      for (let i = 0; i < this.rollingCount; i++) {
        const srcIndex = (this.rollingWrite - this.rollingCount + i + size) % size;
        segment[start + i] = this.rollingTarget[srcIndex];
      }
      return segment;
    }
    for (let i = 0; i < size; i++) {
      segment[i] = this.rollingTarget[(this.rollingWrite + i) % size];
    }
    return segment;
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
      this.rollingTarget = new Float32Array(this.config.fftSize);
      this.rollingWrite = 0;
      this.rollingCount = 0;
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
    if (newConfig.haloReduce !== undefined) {
      if (newConfig.haloReduce !== this.config.haloReduce) {
        this.rollingTarget.fill(0);
        this.rollingWrite = 0;
        this.rollingCount = 0;
      }
      this.config.haloReduce = newConfig.haloReduce;
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): SpectrumConfig {
    return { ...this.config };
  }
}
