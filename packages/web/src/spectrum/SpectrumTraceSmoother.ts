import type { SpectrumLevelDescriptor } from '@tx5dr/contracts';

export interface SpectrumTraceSmoothingConfig {
  /** Exponential time constant for temporal power averaging. */
  temporalTauMs: number;
  /** Target frequency width for the robust median filter. */
  frequencyKernelHz: number;
  /** Maximum median radius (2 means at most a 5-bin window). */
  maxFrequencyRadius: number;
}

export interface SpectrumTraceSmoothingInput {
  frameToken: number | null;
  timestamp: number | null;
  axis: { minHz: number; maxHz: number };
  level: SpectrumLevelDescriptor | null;
}

export const DEFAULT_SPECTRUM_TRACE_SMOOTHING: SpectrumTraceSmoothingConfig = {
  // Keep the trace responsive while still averaging the short-term noise
  // variance. Frequency-direction median filtering remains independent.
  temporalTauMs: 50,
  frequencyKernelHz: 15,
  maxFrequencyRadius: 1,
};

const DEFAULT_FRAME_INTERVAL_MS = 100;
const MIN_DB_VALUE = -180;

function isPowerLevel(level: SpectrumLevelDescriptor | null): boolean {
  return level?.unit !== 'Level';
}

function getMedian3(left: number, center: number, right: number): number {
  return left < center
    ? (center < right ? center : left < right ? right : left)
    : (left < right ? left : center < right ? right : center);
}

function resolveFrequencyRadius(
  axis: { minHz: number; maxHz: number },
  length: number,
  config: SpectrumTraceSmoothingConfig,
): number {
  if (length < 3 || !Number.isFinite(config.frequencyKernelHz) || config.frequencyKernelHz <= 0) {
    return 0;
  }
  const spanHz = axis.maxHz - axis.minHz;
  const resolutionHz = spanHz / Math.max(length - 1, 1);
  if (!Number.isFinite(resolutionHz) || resolutionHz <= 0) return 0;
  const requestedBins = Math.floor(config.frequencyKernelHz / resolutionHz);
  const maxRadius = Math.max(0, Math.floor(config.maxFrequencyRadius));
  return Math.max(0, Math.min(maxRadius, Math.floor(requestedBins / 2)));
}

/**
 * Display-only spectrum smoother. It never mutates the input row and keeps
 * state for one continuous axis. dB/dBFS values are averaged as linear power
 * (`10^(dB/10)`), while raw Level values use a normal linear EMA.
 */
export class SpectrumTraceSmoother {
  private readonly config: SpectrumTraceSmoothingConfig;
  private filteredValues = new Float32Array(0);
  private smoothedValues = new Float32Array(0);
  private smoothedPower = new Float64Array(0);
  private previousTimestamp: number | null = null;
  private axisSignature: string | null = null;
  private initialized = false;

  constructor(config: Partial<SpectrumTraceSmoothingConfig> = {}) {
    this.config = {
      temporalTauMs: Number.isFinite(config.temporalTauMs) && config.temporalTauMs! > 0
        ? config.temporalTauMs!
        : DEFAULT_SPECTRUM_TRACE_SMOOTHING.temporalTauMs,
      frequencyKernelHz: Number.isFinite(config.frequencyKernelHz) && config.frequencyKernelHz! >= 0
        ? config.frequencyKernelHz!
        : DEFAULT_SPECTRUM_TRACE_SMOOTHING.frequencyKernelHz,
      maxFrequencyRadius: Number.isFinite(config.maxFrequencyRadius) && config.maxFrequencyRadius! >= 0
        ? Math.floor(config.maxFrequencyRadius!)
        : DEFAULT_SPECTRUM_TRACE_SMOOTHING.maxFrequencyRadius,
    };
  }

  reset(): void {
    this.filteredValues = new Float32Array(0);
    this.smoothedValues = new Float32Array(0);
    this.smoothedPower = new Float64Array(0);
    this.previousTimestamp = null;
    this.axisSignature = null;
    this.initialized = false;
  }

  process(values: Float32Array, input: SpectrumTraceSmoothingInput): Float32Array {
    if (values.length === 0 || !Number.isFinite(input.axis.minHz) || !Number.isFinite(input.axis.maxHz)) {
      this.reset();
      return values;
    }

    const levelKey = input.level
      ? `${input.level.domain}:${input.level.unit}:${input.level.min}:${input.level.max}`
      : 'db';
    const axisKey = `${input.axis.minHz}:${input.axis.maxHz}:${values.length}:${levelKey}`;
    const axisChanged = this.axisSignature !== axisKey;
    if (axisChanged || this.filteredValues.length !== values.length) {
      this.filteredValues = new Float32Array(values.length);
      this.smoothedValues = new Float32Array(values.length);
      this.smoothedPower = new Float64Array(values.length);
      this.axisSignature = axisKey;
      this.previousTimestamp = null;
      this.initialized = false;
    }

    const radius = resolveFrequencyRadius(input.axis, values.length, this.config);
    if (radius === 0) {
      this.filteredValues.set(values);
    } else {
      for (let index = 0; index < values.length; index += 1) {
        const left = values[Math.max(0, index - 1)]!;
        const center = values[index]!;
        const right = values[Math.min(values.length - 1, index + 1)]!;
        this.filteredValues[index] = getMedian3(left, center, right);
      }
    }

    const timestamp = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
      ? input.timestamp
      : null;
    const deltaMs = this.previousTimestamp === null || timestamp === null
      ? DEFAULT_FRAME_INTERVAL_MS
      : Math.max(1, Math.min(1_000, timestamp - this.previousTimestamp));
    this.previousTimestamp = timestamp;
    const tauMs = Math.max(1, this.config.temporalTauMs);
    const alpha = 1 - Math.exp(-deltaMs / tauMs);
    const powerDomain = isPowerLevel(input.level);

    for (let index = 0; index < values.length; index += 1) {
      const value = Number.isFinite(this.filteredValues[index]) ? this.filteredValues[index]! : 0;
      if (powerDomain) {
        const db = Math.max(MIN_DB_VALUE, value);
        const power = 10 ** (db / 10);
        if (!this.initialized) {
          this.smoothedPower[index] = power;
        } else {
          this.smoothedPower[index] += alpha * (power - this.smoothedPower[index]!);
        }
        this.smoothedValues[index] = 10 * Math.log10(Math.max(this.smoothedPower[index]!, 10 ** (MIN_DB_VALUE / 10)));
      } else if (!this.initialized) {
        this.smoothedValues[index] = value;
      } else {
        this.smoothedValues[index] += alpha * (value - this.smoothedValues[index]!);
      }
    }

    this.initialized = true;
    return this.smoothedValues;
  }
}
