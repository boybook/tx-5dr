export const DEEP_CW_FFT_LENGTH = 768;
export const DEEP_CW_HOP_LENGTH = 192;
export const DEEP_CW_SAMPLE_RATE = 9_600;
export const DEEP_CW_BIN_RESOLUTION = DEEP_CW_SAMPLE_RATE / DEEP_CW_FFT_LENGTH;
export const DEEP_CW_DECODABLE_MIN_FREQ_HZ = 400;
export const DEEP_CW_DECODABLE_MAX_FREQ_HZ = 1_200;

const FFT_LENGTH = DEEP_CW_FFT_LENGTH;
const HOP_LENGTH = DEEP_CW_HOP_LENGTH;
const SAMPLE_RATE = DEEP_CW_SAMPLE_RATE;
const BIN_RESOLUTION = DEEP_CW_BIN_RESOLUTION;
const DECODABLE_MIN_FREQ_HZ = DEEP_CW_DECODABLE_MIN_FREQ_HZ;
const DECODABLE_MAX_FREQ_HZ = DEEP_CW_DECODABLE_MAX_FREQ_HZ;
const TOTAL_BINS = FFT_LENGTH / 2 + 1;
const START_BIN = Math.round(DECODABLE_MIN_FREQ_HZ / BIN_RESOLUTION);
const END_BIN = Math.round(DECODABLE_MAX_FREQ_HZ / BIN_RESOLUTION) + 1;
const CROPPED_BINS = END_BIN - START_BIN;
const NORMAL_CENTER_BIN = Math.round((START_BIN + END_BIN - 1) / 2);

export type DeepCWInputType = 'float16' | 'float32';

export interface DeepCWSpectrogramTensor {
  data: Float32Array | Uint16Array;
  dims: [number, 1, number, number];
  type: DeepCWInputType;
}

export interface DeepCWBandMapping {
  targetBin: number;
  halfWidthBins: number;
  sourceStartBin: number;
  sourceEndBin: number;
  destStartIndex: number;
  destEndIndex: number;
  effectiveMinFreqHz: number;
  effectiveMaxFreqHz: number;
  croppedBins: number;
}

export type DeepCWSignalClassification = 'silence' | 'noise' | 'off_target' | 'target_tone' | 'unknown';

export interface DeepCWSignalAnalysis {
  sampleRate: number;
  durationMs: number;
  targetFreqHz: number;
  filterWidthHz: number;
  effectiveBandMinHz: number;
  effectiveBandMaxHz: number;
  rmsDbfs: number;
  peakFreqHz: number;
  peakPowerDb: number;
  bandPowerDb: number;
  noiseFloorDb: number;
  snrDb: number;
  inBandPeakOffsetHz: number;
  activeFrameRatio: number;
  classification: DeepCWSignalClassification;
  updatedAt: number;
}

class FFT {
  private readonly isPowerOfTwo: boolean;
  private reverseTable?: Uint32Array;
  private sinTable?: Float32Array;
  private cosTable?: Float32Array;
  private bluesteinSize?: number;
  private bluesteinChirpTable?: Float32Array;
  private bluesteinKernelFft?: Float32Array;
  private bluesteinFft?: FFT;

  constructor(public readonly fftSize: number) {
    this.isPowerOfTwo = (fftSize & (fftSize - 1)) === 0;
    if (!this.isPowerOfTwo) {
      this.initializeBluesteinTables();
      return;
    }
    this.initializePowerOfTwoTables();
  }

  private initializePowerOfTwoTables(): void {
    this.reverseTable = new Uint32Array(this.fftSize);
    this.sinTable = new Float32Array(this.fftSize);
    this.cosTable = new Float32Array(this.fftSize);
    let limit = 1;
    let bit = this.fftSize >> 1;
    while (limit < this.fftSize) {
      for (let i = 0; i < limit; i += 1) {
        this.reverseTable[i + limit] = this.reverseTable[i]! + bit;
      }
      limit <<= 1;
      bit >>= 1;
    }
    for (let i = 0; i < this.fftSize; i += 1) {
      const angle = (-2 * Math.PI * i) / this.fftSize;
      this.sinTable[i] = Math.sin(angle);
      this.cosTable[i] = Math.cos(angle);
    }
  }

  private initializeBluesteinTables(): void {
    const convolutionSize = nextPowerOfTwo(this.fftSize * 2 - 1);
    const chirpTable = new Float32Array(this.fftSize * 2);
    const kernel = new Float32Array(convolutionSize * 2);

    for (let i = 0; i < this.fftSize; i += 1) {
      const angle = (Math.PI * ((i * i) % (this.fftSize * 2))) / this.fftSize;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      chirpTable[i * 2] = cos;
      chirpTable[i * 2 + 1] = sin;
      kernel[i * 2] = cos;
      kernel[i * 2 + 1] = sin;
      if (i !== 0) {
        const mirroredIndex = convolutionSize - i;
        kernel[mirroredIndex * 2] = cos;
        kernel[mirroredIndex * 2 + 1] = sin;
      }
    }

    const bluesteinFft = new FFT(convolutionSize);
    bluesteinFft.transform(kernel);
    this.bluesteinSize = convolutionSize;
    this.bluesteinChirpTable = chirpTable;
    this.bluesteinKernelFft = kernel;
    this.bluesteinFft = bluesteinFft;
  }

  transform(complexArray: Float32Array): void {
    if (this.isPowerOfTwo) {
      this.powerOfTwoTransform(complexArray);
      return;
    }
    this.bluesteinTransform(complexArray);
  }

  private powerOfTwoTransform(complexArray: Float32Array): void {
    const reverseTable = this.reverseTable!;
    const sinTable = this.sinTable!;
    const cosTable = this.cosTable!;
    for (let i = 0; i < this.fftSize; i += 1) {
      const reversedIndex = reverseTable[i]!;
      if (i < reversedIndex) {
        const real = complexArray[i * 2]!;
        const imag = complexArray[i * 2 + 1]!;
        complexArray[i * 2] = complexArray[reversedIndex * 2]!;
        complexArray[i * 2 + 1] = complexArray[reversedIndex * 2 + 1]!;
        complexArray[reversedIndex * 2] = real;
        complexArray[reversedIndex * 2 + 1] = imag;
      }
    }

    for (let halfSize = 1; halfSize < this.fftSize; halfSize *= 2) {
      const step = halfSize * 2;
      const angleStep = this.fftSize / step;
      for (let i = 0; i < this.fftSize; i += step) {
        for (let j = 0; j < halfSize; j += 1) {
          const angleIndex = j * angleStep;
          const wReal = cosTable[angleIndex]!;
          const wImag = sinTable[angleIndex]!;
          const left = (i + j) * 2;
          const right = (i + j + halfSize) * 2;
          const tr = wReal * complexArray[right]! - wImag * complexArray[right + 1]!;
          const ti = wReal * complexArray[right + 1]! + wImag * complexArray[right]!;
          const ur = complexArray[left]!;
          const ui = complexArray[left + 1]!;
          complexArray[left] = ur + tr;
          complexArray[left + 1] = ui + ti;
          complexArray[right] = ur - tr;
          complexArray[right + 1] = ui - ti;
        }
      }
    }
  }

  private bluesteinTransform(complexArray: Float32Array): void {
    const convolutionSize = this.bluesteinSize!;
    const chirpTable = this.bluesteinChirpTable!;
    const kernelFft = this.bluesteinKernelFft!;
    const bluesteinFft = this.bluesteinFft!;
    const work = new Float32Array(convolutionSize * 2);

    for (let i = 0; i < this.fftSize; i += 1) {
      const inputReal = complexArray[i * 2]!;
      const inputImag = complexArray[i * 2 + 1]!;
      const chirpReal = chirpTable[i * 2]!;
      const chirpImag = chirpTable[i * 2 + 1]!;
      work[i * 2] = inputReal * chirpReal + inputImag * chirpImag;
      work[i * 2 + 1] = inputImag * chirpReal - inputReal * chirpImag;
    }

    bluesteinFft.transform(work);
    for (let i = 0; i < convolutionSize; i += 1) {
      const workReal = work[i * 2]!;
      const workImag = work[i * 2 + 1]!;
      const kernelReal = kernelFft[i * 2]!;
      const kernelImag = kernelFft[i * 2 + 1]!;
      work[i * 2] = workReal * kernelReal - workImag * kernelImag;
      work[i * 2 + 1] = workReal * kernelImag + workImag * kernelReal;
    }

    inverseTransform(work, bluesteinFft);
    for (let i = 0; i < this.fftSize; i += 1) {
      const workReal = work[i * 2]!;
      const workImag = work[i * 2 + 1]!;
      const chirpReal = chirpTable[i * 2]!;
      const chirpImag = chirpTable[i * 2 + 1]!;
      complexArray[i * 2] = workReal * chirpReal + workImag * chirpImag;
      complexArray[i * 2 + 1] = workImag * chirpReal - workReal * chirpImag;
    }
  }
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power <<= 1;
  return power;
}

function inverseTransform(complexArray: Float32Array, fft: FFT): void {
  for (let i = 0; i < fft.fftSize; i += 1) {
    complexArray[i * 2 + 1] = -complexArray[i * 2 + 1]!;
  }
  fft.transform(complexArray);
  for (let i = 0; i < fft.fftSize; i += 1) {
    complexArray[i * 2] = complexArray[i * 2]! / fft.fftSize;
    complexArray[i * 2 + 1] = -complexArray[i * 2 + 1]! / fft.fftSize;
  }
}

class STFT {
  private readonly fft = new FFT(FFT_LENGTH);
  private readonly window = new Float32Array(FFT_LENGTH);
  private readonly complexFrame = new Float32Array(FFT_LENGTH * 2);

  constructor() {
    for (let i = 0; i < FFT_LENGTH; i += 1) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_LENGTH));
    }
  }

  getFrameCount(signalLength: number): number {
    if (signalLength < FFT_LENGTH) return 0;
    return Math.floor((signalLength - FFT_LENGTH) / HOP_LENGTH) + 1;
  }

  forEachSpectrum(signal: Float32Array, iteratee: (complexFrame: Float32Array, frameIndex: number) => void): number {
    const frameCount = this.getFrameCount(signal.length);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const offset = frameIndex * HOP_LENGTH;
      this.complexFrame.fill(0);
      for (let i = 0; i < FFT_LENGTH; i += 1) {
        this.complexFrame[i * 2] = (signal[offset + i] ?? 0) * this.window[i]!;
      }
      this.fft.transform(this.complexFrame);
      iteratee(this.complexFrame, frameIndex);
    }
    return frameCount;
  }
}

const stft = new STFT();

if (CROPPED_BINS !== 65 || END_BIN > TOTAL_BINS) {
  throw new Error(`Invalid DeepCW spectrogram configuration: bins=${CROPPED_BINS}`);
}

export const DEEP_CW_CROPPED_BINS = CROPPED_BINS;

export function getDeepCWBandMapping(targetFreqHz: number, filterWidthHz: number): DeepCWBandMapping {
  const targetBin = Math.round(targetFreqHz / BIN_RESOLUTION);
  const halfWidthBins = Math.ceil(filterWidthHz / 2 / BIN_RESOLUTION);
  const sourceStartBin = targetBin - halfWidthBins;
  const sourceEndBin = targetBin + halfWidthBins;
  const destCenterIdx = NORMAL_CENTER_BIN - START_BIN;
  return {
    targetBin,
    halfWidthBins,
    sourceStartBin,
    sourceEndBin,
    destStartIndex: destCenterIdx - halfWidthBins,
    destEndIndex: destCenterIdx + halfWidthBins,
    effectiveMinFreqHz: sourceStartBin * BIN_RESOLUTION,
    effectiveMaxFreqHz: sourceEndBin * BIN_RESOLUTION,
    croppedBins: CROPPED_BINS,
  };
}

const SIGNAL_ANALYSIS_MIN_FREQ_HZ = 100;
const SIGNAL_ANALYSIS_MAX_FREQ_HZ = 1_500;
const SILENCE_RMS_DBFS = -70;
const TARGET_TONE_MIN_SNR_DB = 8;
const ACTIVE_FRAME_MIN_SNR_DB = 6;
const POWER_FLOOR = 1e-12;

export function analyzeDeepCWSignal(
  audio: Float32Array,
  sampleRate: number,
  targetFreqHz: number,
  filterWidthHz: number,
  updatedAt = Date.now(),
): DeepCWSignalAnalysis {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.floor(sampleRate) : SAMPLE_RATE;
  const durationMs = (audio.length / safeSampleRate) * 1000;
  const mapping = getDeepCWBandMapping(targetFreqHz, filterWidthHz);
  const effectiveBandMinHz = Math.max(0, mapping.sourceStartBin * BIN_RESOLUTION);
  const effectiveBandMaxHz = Math.min(SAMPLE_RATE / 2, mapping.sourceEndBin * BIN_RESOLUTION);
  const rmsDbfs = amplitudeToDbfs(rootMeanSquare(audio));
  const frameCount = stft.getFrameCount(audio.length);

  if (frameCount === 0 || rmsDbfs <= SILENCE_RMS_DBFS) {
    const classification: DeepCWSignalClassification = rmsDbfs <= SILENCE_RMS_DBFS ? 'silence' : 'unknown';
    return {
      sampleRate: safeSampleRate,
      durationMs,
      targetFreqHz,
      filterWidthHz,
      effectiveBandMinHz,
      effectiveBandMaxHz,
      rmsDbfs,
      peakFreqHz: targetFreqHz,
      peakPowerDb: powerToDb(0),
      bandPowerDb: powerToDb(0),
      noiseFloorDb: powerToDb(0),
      snrDb: 0,
      inBandPeakOffsetHz: 0,
      activeFrameRatio: 0,
      classification,
      updatedAt,
    };
  }

  const searchStartBin = Math.max(1, Math.round(SIGNAL_ANALYSIS_MIN_FREQ_HZ / BIN_RESOLUTION));
  const searchEndBin = Math.min(TOTAL_BINS - 1, Math.round(SIGNAL_ANALYSIS_MAX_FREQ_HZ / BIN_RESOLUTION));
  const bandStartBin = Math.max(searchStartBin, mapping.sourceStartBin);
  const bandEndBin = Math.min(searchEndBin, mapping.sourceEndBin);
  const binPowers = new Float64Array(TOTAL_BINS);
  const bandFramePeakPowers: number[] = [];
  let bandPowerSum = 0;
  let bandPowerCount = 0;

  stft.forEachSpectrum(audio, (complexFrame) => {
    let frameBandPeakPower = 0;
    for (let bin = searchStartBin; bin <= searchEndBin; bin += 1) {
      const real = complexFrame[bin * 2]!;
      const imag = complexFrame[bin * 2 + 1]!;
      const power = real * real + imag * imag;
      binPowers[bin] += power;
      if (bin >= bandStartBin && bin <= bandEndBin) {
        bandPowerSum += power;
        bandPowerCount += 1;
        if (power > frameBandPeakPower) frameBandPeakPower = power;
      }
    }
    bandFramePeakPowers.push(frameBandPeakPower);
  });

  let peakBin = searchStartBin;
  let peakPower = 0;
  const noisePowers: number[] = [];
  for (let bin = searchStartBin; bin <= searchEndBin; bin += 1) {
    const averagePower = binPowers[bin]! / frameCount;
    if (averagePower > peakPower) {
      peakPower = averagePower;
      peakBin = bin;
    }
    if (bin < bandStartBin || bin > bandEndBin) {
      noisePowers.push(averagePower);
    }
  }

  const peakFreqHz = peakBin * BIN_RESOLUTION;
  const peakPowerDb = powerToDb(peakPower);
  const bandPowerDb = powerToDb(bandPowerCount > 0 ? bandPowerSum / bandPowerCount : 0);
  const noiseFloorDb = powerToDb(median(noisePowers));
  const snrDb = Math.max(0, peakPowerDb - noiseFloorDb);
  const isPeakInBand = peakBin >= bandStartBin && peakBin <= bandEndBin;
  const activeFrameThresholdDb = noiseFloorDb + ACTIVE_FRAME_MIN_SNR_DB;
  const activeFrames = bandFramePeakPowers.filter(power => powerToDb(power) >= activeFrameThresholdDb).length;
  const activeFrameRatio = bandFramePeakPowers.length > 0 ? activeFrames / bandFramePeakPowers.length : 0;

  const classification: DeepCWSignalClassification = snrDb < TARGET_TONE_MIN_SNR_DB
    ? 'noise'
    : isPeakInBand
      ? 'target_tone'
      : 'off_target';

  return {
    sampleRate: safeSampleRate,
    durationMs,
    targetFreqHz,
    filterWidthHz,
    effectiveBandMinHz,
    effectiveBandMaxHz,
    rmsDbfs,
    peakFreqHz,
    peakPowerDb,
    bandPowerDb,
    noiseFloorDb,
    snrDb,
    inBandPeakOffsetHz: peakFreqHz - targetFreqHz,
    activeFrameRatio,
    classification,
    updatedAt,
  };
}

export function audioToDeepCWSpectrogramTensor(
  audio: Float32Array,
  inputType: DeepCWInputType,
  targetFreqHz: number | null,
  filterWidthHz: number,
): DeepCWSpectrogramTensor | null {
  const timeSteps = stft.getFrameCount(audio.length);
  if (timeSteps === 0) return null;

  const flattened = new Float32Array(timeSteps * CROPPED_BINS);
  if (targetFreqHz != null && filterWidthHz > 0) {
    fillShiftedSpectrogram(audio, flattened, targetFreqHz, filterWidthHz);
  } else {
    fillWideSpectrogram(audio, flattened);
  }
  normalizeCmvn(flattened);

  return {
    data: inputType === 'float16' ? float32ToFloat16Array(flattened) : flattened,
    dims: [1, 1, timeSteps, CROPPED_BINS],
    type: inputType,
  };
}

function fillWideSpectrogram(audio: Float32Array, output: Float32Array): void {
  stft.forEachSpectrum(audio, (complexFrame, frameIndex) => {
    const offset = frameIndex * CROPPED_BINS;
    for (let bin = START_BIN; bin < END_BIN; bin += 1) {
      const real = complexFrame[bin * 2]!;
      const imag = complexFrame[bin * 2 + 1]!;
      output[offset + bin - START_BIN] = Math.sqrt(real * real + imag * imag);
    }
  });
}

function fillShiftedSpectrogram(audio: Float32Array, output: Float32Array, targetFreqHz: number, filterWidthHz: number): void {
  const { targetBin, halfWidthBins } = getDeepCWBandMapping(targetFreqHz, filterWidthHz);
  const destCenterIdx = NORMAL_CENTER_BIN - START_BIN;
  stft.forEachSpectrum(audio, (complexFrame, frameIndex) => {
    const offset = frameIndex * CROPPED_BINS;
    for (let delta = -halfWidthBins; delta <= halfWidthBins; delta += 1) {
      const sourceBin = targetBin + delta;
      const destIndex = destCenterIdx + delta;
      if (sourceBin < 0 || sourceBin >= TOTAL_BINS || destIndex < 0 || destIndex >= CROPPED_BINS) continue;
      const real = complexFrame[sourceBin * 2]!;
      const imag = complexFrame[sourceBin * 2 + 1]!;
      output[offset + destIndex] = Math.sqrt(real * real + imag * imag);
    }
  });
}

function normalizeCmvn(values: Float32Array): void {
  let mean = 0;
  for (let i = 0; i < values.length; i += 1) mean += values[i]!;
  mean /= Math.max(values.length, 1);
  let variance = 0;
  for (let i = 0; i < values.length; i += 1) {
    const centered = values[i]! - mean;
    variance += centered * centered;
  }
  const std = Math.max(Math.sqrt(variance / Math.max(values.length, 1)), 1e-5);
  for (let i = 0; i < values.length; i += 1) values[i] = (values[i]! - mean) / std;
}

function rootMeanSquare(values: Float32Array): number {
  if (values.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!;
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / values.length);
}

function amplitudeToDbfs(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function powerToDb(power: number): number {
  return 10 * Math.log10(Math.max(power, POWER_FLOOR));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function float32ToFloat16Array(values: Float32Array): Uint16Array {
  const output = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i += 1) output[i] = float32ToFloat16Bits(values[i]!);
  return output;
}

function float32ToFloat16Bits(value: number): number {
  float32Scratch[0] = value;
  const word = uint32Scratch[0]!;
  const sign = (word >> 16) & 0x8000;
  const exponent = (word >> 23) & 0xff;
  let mantissa = (word >> 12) & 0x07ff;

  if (exponent < 103) {
    return sign;
  }

  if (exponent > 142) {
    let bits = sign | 0x7c00;
    if (exponent === 255 && (word & 0x007fffff) !== 0) {
      bits |= 1;
    }
    return bits;
  }

  if (exponent < 113) {
    mantissa |= 0x0800;
    return sign | (mantissa >> (114 - exponent)) | ((mantissa >> (113 - exponent)) & 1);
  }

  let bits = sign | ((exponent - 112) << 10) | (mantissa >> 1);
  bits += mantissa & 1;
  return bits;
}

const float16ScratchBuffer = new ArrayBuffer(4);
const float32Scratch = new Float32Array(float16ScratchBuffer);
const uint32Scratch = new Uint32Array(float16ScratchBuffer);
