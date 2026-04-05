import type { LevelMeterReading } from '@tx5dr/contracts';

const HF_S9_DBM = -73;    // HF: S9 = -73 dBm (< 30 MHz), IARU standard
const VHF_S9_DBM = -93;   // VHF/UHF: S9 = -93 dBm (>= 30 MHz), IARU Region 1
const DB_PER_S_UNIT = 6;
const VHF_THRESHOLD_HZ = 30_000_000; // 30 MHz boundary

const YAESU_RAWSTR_POINTS = [
  { raw: 0, dbOffset: -54 },
  { raw: 25, dbOffset: -48 },
  { raw: 38, dbOffset: -42 },
  { raw: 52, dbOffset: -36 },
  { raw: 70, dbOffset: -30 },
  { raw: 90, dbOffset: -24 },
  { raw: 102, dbOffset: -18 },
  { raw: 120, dbOffset: -12 },
  { raw: 135, dbOffset: -6 },
  { raw: 150, dbOffset: 0 },
  { raw: 170, dbOffset: 10 },
  { raw: 189, dbOffset: 20 },
  { raw: 197, dbOffset: 30 },
  { raw: 214, dbOffset: 40 },
  { raw: 225, dbOffset: 50 },
  { raw: 235, dbOffset: 60 },
] as const;

export type MeterDecodeStrategyName = 'icom' | 'yaesu' | 'generic';
export type MeterDecodeSource = 'STRENGTH' | 'RAWSTR';

export interface MeterDecodeStrategy {
  name: MeterDecodeStrategyName;
  sourceLevel: MeterDecodeSource | null;
  displayStyle: LevelMeterReading['displayStyle'];
  label: string;
}

interface ResolveHamlibMeterDecodeStrategyOptions {
  manufacturer?: string | null;
  supportedLevels: Iterable<string>;
}

const NO_LEVEL_METER_STRATEGY: MeterDecodeStrategy = {
  name: 'generic',
  sourceLevel: null,
  displayStyle: 'db-over-s9',
  label: 'generic-no-level',
};

function clampProgressPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatRelativeDbOffset(dbOffset: number): string {
  const rounded = Math.round(dbOffset);
  const sign = rounded > 0 ? `+${rounded}` : `${rounded}`;
  return `${sign} dB@S9`;
}

function formatSValue(dbOffset: number): string {
  if (dbOffset > 0) {
    return `S9+${Math.round(dbOffset)}dB`;
  }

  const sUnits = Math.max(0, Math.min(9, Math.round((dbOffset + 54) / DB_PER_S_UNIT)));
  return `S${sUnits}`;
}

function buildLevelMeterReading(
  raw: number,
  dbOffset: number,
  frequencyHz: number,
  displayStyle: LevelMeterReading['displayStyle'],
  formatted: string
): LevelMeterReading {
  const s9Dbm = getS9ReferenceDbm(frequencyHz);
  const s0Dbm = s9Dbm - 9 * DB_PER_S_UNIT;
  const s9Plus60Dbm = s9Dbm + 60;
  const dBm = s9Dbm + dbOffset;
  const clampedDbm = Math.max(s0Dbm, Math.min(s9Plus60Dbm, dBm));
  const percent = clampProgressPercent(((clampedDbm - s0Dbm) / (s9Plus60Dbm - s0Dbm)) * 100);
  const sUnitsRaw = (dBm - s0Dbm) / DB_PER_S_UNIT;
  const sUnits = Math.max(0, Math.min(9, sUnitsRaw));
  const dbAboveS9 = dBm > s9Dbm ? Math.round(dBm - s9Dbm) : undefined;

  return {
    raw,
    percent,
    sUnits,
    dbAboveS9,
    dBm,
    formatted,
    displayStyle,
  };
}

function interpolateYaesuDbOffset(rawValue: number): number {
  if (rawValue <= YAESU_RAWSTR_POINTS[0].raw) {
    return YAESU_RAWSTR_POINTS[0].dbOffset;
  }

  const lastPoint = YAESU_RAWSTR_POINTS[YAESU_RAWSTR_POINTS.length - 1];
  if (rawValue >= lastPoint.raw) {
    return lastPoint.dbOffset;
  }

  for (let i = 1; i < YAESU_RAWSTR_POINTS.length; i += 1) {
    const previousPoint = YAESU_RAWSTR_POINTS[i - 1];
    const nextPoint = YAESU_RAWSTR_POINTS[i];
    if (rawValue <= nextPoint.raw) {
      const range = nextPoint.raw - previousPoint.raw;
      const progress = range === 0 ? 0 : (rawValue - previousPoint.raw) / range;
      return previousPoint.dbOffset + ((nextPoint.dbOffset - previousPoint.dbOffset) * progress);
    }
  }

  return lastPoint.dbOffset;
}

/**
 * Determine S9 reference dBm based on frequency.
 * HF (<30 MHz): S9 = -73 dBm; VHF/UHF (>=30 MHz): S9 = -93 dBm.
 */
export function getS9ReferenceDbm(frequencyHz: number): number {
  return frequencyHz >= VHF_THRESHOLD_HZ ? VHF_S9_DBM : HF_S9_DBM;
}

/**
 * Resolve which meter decoding strategy Hamlib should use for the current rig.
 */
export function resolveHamlibMeterDecodeStrategy(
  options: ResolveHamlibMeterDecodeStrategyOptions
): MeterDecodeStrategy {
  const manufacturer = options.manufacturer?.trim().toUpperCase();
  const supportedLevels = new Set(options.supportedLevels);

  if (manufacturer === 'YAESU' && supportedLevels.has('RAWSTR')) {
    return {
      name: 'yaesu',
      sourceLevel: 'RAWSTR',
      displayStyle: 's-meter',
      label: 'yaesu-rawstr',
    };
  }

  if (manufacturer === 'ICOM' && supportedLevels.has('STRENGTH')) {
    return {
      name: 'icom',
      sourceLevel: 'STRENGTH',
      displayStyle: 's-meter-dbm',
      label: 'icom-strength',
    };
  }

  if (supportedLevels.has('STRENGTH')) {
    return {
      name: 'generic',
      sourceLevel: 'STRENGTH',
      displayStyle: 'db-over-s9',
      label: 'generic-strength',
    };
  }

  return NO_LEVEL_METER_STRATEGY;
}

/**
 * Convert Hamlib STRENGTH dB offset (relative to S9) to an ICOM/standard S-meter reading.
 */
export function hamlibStrengthToLevelMeterReading(
  hamlibDbOffset: number,
  frequencyHz: number = 0
): LevelMeterReading {
  return buildLevelMeterReading(
    Math.round((clampProgressPercent((hamlibDbOffset + 54) / 114 * 100) / 100) * 255),
    hamlibDbOffset,
    frequencyHz,
    's-meter-dbm',
    formatSValue(hamlibDbOffset),
  );
}

/**
 * Convert Hamlib STRENGTH dB offset (relative to S9) to a generic non-branded reading.
 */
export function genericHamlibStrengthToLevelMeterReading(
  hamlibDbOffset: number,
  frequencyHz: number = 0
): LevelMeterReading {
  return buildLevelMeterReading(
    Math.round((clampProgressPercent((hamlibDbOffset + 54) / 114 * 100) / 100) * 255),
    hamlibDbOffset,
    frequencyHz,
    'db-over-s9',
    formatRelativeDbOffset(hamlibDbOffset),
  );
}

/**
 * Convert Yaesu RAWSTR values to a branded S-meter reading.
 */
export function yaesuRawstrToLevelMeterReading(
  rawValue: number,
  frequencyHz: number = 0
): LevelMeterReading {
  const dbOffset = interpolateYaesuDbOffset(rawValue);
  return buildLevelMeterReading(
    rawValue,
    dbOffset,
    frequencyHz,
    's-meter',
    formatSValue(dbOffset),
  );
}
