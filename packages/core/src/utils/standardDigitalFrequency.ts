export const STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ = 1500;

export const STANDARD_DIGITAL_FREQUENCIES_HZ = {
  FT8: [
    1840000,
    3573000,
    7074000,
    10136000,
    14074000,
    18100000,
    21074000,
    24915000,
    28074000,
    50313000,
    144174000,
    144460000,
    432174000,
  ],
  FT4: [
    1842000,
    3575000,
    7047500,
    10140000,
    14080000,
    18104000,
    21140000,
    24919000,
    28180000,
    50318000,
  ],
} as const;

export type StandardDigitalModeName = keyof typeof STANDARD_DIGITAL_FREQUENCIES_HZ;

export interface StandardDigitalFrequencyMatch {
  modeName: StandardDigitalModeName;
  standardFrequency: number;
}

function normalizeModeName(modeName: string | null | undefined): StandardDigitalModeName | null {
  const normalized = modeName?.trim().toUpperCase();
  return normalized === 'FT8' || normalized === 'FT4' ? normalized : null;
}

export function getStandardDigitalFrequencyMatch(
  modeName: string | null | undefined,
  frequency: number | null | undefined,
): StandardDigitalFrequencyMatch | null {
  const digitalModeName = normalizeModeName(modeName);
  if (!digitalModeName || typeof frequency !== 'number' || !Number.isFinite(frequency)) {
    return null;
  }

  const standardFrequency = STANDARD_DIGITAL_FREQUENCIES_HZ[digitalModeName].find(
    (candidate) => Math.abs(candidate - frequency) <= STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ,
  );

  return standardFrequency ? { modeName: digitalModeName, standardFrequency } : null;
}
