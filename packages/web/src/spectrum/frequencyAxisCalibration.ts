export interface FrequencyAxisCalibrationAnchor {
  /** Real/CAT/operator frequency offset from the current SDR reference frequency, in Hz. */
  actualOffsetHz: number;
  /** Raw SDR image frequency offset where that real offset should visually align, in Hz. */
  visualOffsetHz: number;
}

export interface FrequencyAxisCalibrationConfig {
  enabled: boolean;
  anchors: FrequencyAxisCalibrationAnchor[];
}

export interface FrequencyAxisTransform {
  readonly isIdentity: boolean;
  toVisualHz(actualHz: number): number;
  toActualHz(visualHz: number): number;
}

export const IDENTITY_FREQUENCY_AXIS_TRANSFORM: FrequencyAxisTransform = {
  isIdentity: true,
  toVisualHz: (actualHz: number) => actualHz,
  toActualHz: (visualHz: number) => visualHz,
};

// Local-only tuning entrypoint. Enable and edit relative anchors after measuring ICOM SDR drift.
export const ICOM_RADIO_SDR_FREQUENCY_AXIS_CALIBRATION: FrequencyAxisCalibrationConfig = {
  enabled: true,
  anchors: [
    { actualOffsetHz: -3000, visualOffsetHz: -2860 },
    { actualOffsetHz: 0, visualOffsetHz: 0 },
    { actualOffsetHz: 3000, visualOffsetHz: 2860 },
  ],
};

interface NormalizedFrequencyAxisCalibration {
  anchors: FrequencyAxisCalibrationAnchor[];
}

function isFiniteFrequency(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeCalibrationConfig(
  config: FrequencyAxisCalibrationConfig | null | undefined,
): NormalizedFrequencyAxisCalibration | null {
  if (!config?.enabled || !Array.isArray(config.anchors) || config.anchors.length < 2) {
    return null;
  }

  if (!config.anchors.every(anchor => isFiniteFrequency(anchor.actualOffsetHz) && isFiniteFrequency(anchor.visualOffsetHz))) {
    return null;
  }

  const anchors = config.anchors
    .map(anchor => ({ actualOffsetHz: anchor.actualOffsetHz, visualOffsetHz: anchor.visualOffsetHz }))
    .sort((left, right) => left.actualOffsetHz - right.actualOffsetHz);

  if (anchors.length < 2) {
    return null;
  }

  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const current = anchors[index];
    if (current.actualOffsetHz <= previous.actualOffsetHz || current.visualOffsetHz <= previous.visualOffsetHz) {
      return null;
    }
  }

  return { anchors };
}

function interpolate(
  input: number,
  lowerInput: number,
  upperInput: number,
  lowerOutput: number,
  upperOutput: number,
): number {
  const ratio = (input - lowerInput) / (upperInput - lowerInput);
  return lowerOutput + ratio * (upperOutput - lowerOutput);
}

function mapWithAnchors(
  input: number,
  anchors: FrequencyAxisCalibrationAnchor[],
  inputKey: 'actualOffsetHz' | 'visualOffsetHz',
  outputKey: 'actualOffsetHz' | 'visualOffsetHz',
): number {
  if (!isFiniteFrequency(input)) {
    return input;
  }

  const first = anchors[0];
  const last = anchors[anchors.length - 1];

  if (input <= first[inputKey]) {
    return input + (first[outputKey] - first[inputKey]);
  }
  if (input >= last[inputKey]) {
    return input + (last[outputKey] - last[inputKey]);
  }

  for (let index = 1; index < anchors.length; index += 1) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    if (input <= upper[inputKey]) {
      return interpolate(input, lower[inputKey], upper[inputKey], lower[outputKey], upper[outputKey]);
    }
  }

  return input;
}

export function createFrequencyAxisTransform(
  config: FrequencyAxisCalibrationConfig | null | undefined,
  referenceFrequencyHz = 0,
): FrequencyAxisTransform {
  const normalized = normalizeCalibrationConfig(config);
  if (!normalized || !isFiniteFrequency(referenceFrequencyHz)) {
    return IDENTITY_FREQUENCY_AXIS_TRANSFORM;
  }

  const { anchors } = normalized;
  return {
    isIdentity: false,
    toVisualHz: (actualHz: number) => referenceFrequencyHz + mapWithAnchors(
      actualHz - referenceFrequencyHz,
      anchors,
      'actualOffsetHz',
      'visualOffsetHz',
    ),
    toActualHz: (visualHz: number) => referenceFrequencyHz + mapWithAnchors(
      visualHz - referenceFrequencyHz,
      anchors,
      'visualOffsetHz',
      'actualOffsetHz',
    ),
  };
}
