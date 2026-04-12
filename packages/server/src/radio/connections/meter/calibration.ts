import type { LevelMeterReading } from '@tx5dr/contracts';
import {
  buildLevelMeterReading as _buildLevelMeterReading,
  formatSValue as _formatSValue,
} from '../meterUtils.js';

// Re-export existing level calibration functions used by the default profile.
export {
  hamlibStrengthToLevelMeterReading,
  genericHamlibStrengthToLevelMeterReading,
  yaesuRawstrToLevelMeterReading,
  getS9ReferenceDbm,
  buildLevelMeterReading,
  formatSValue,
} from '../meterUtils.js';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * Linear mapping from a raw integer range to 0-100 percent.
 */
export function linearRawToPercent(raw: number, max: number = 255): number {
  return Math.min(100, Math.max(0, (raw / max) * 100));
}

/**
 * Clamp a percentage value to [0, 100].
 */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * A single calibration point: raw ADC value -> physical value.
 */
export interface CalPoint {
  raw: number;
  val: number;
}

/**
 * Piece-wise linear interpolation over an ordered calibration table.
 * Clamps at boundary values (same behaviour as Hamlib's rig_raw2val_float).
 */
export function interpolateCalTable(raw: number, table: readonly CalPoint[]): number {
  if (table.length === 0) return raw;
  if (raw <= table[0].raw) return table[0].val;
  const last = table[table.length - 1];
  if (raw >= last.raw) return last.val;

  for (let i = 1; i < table.length; i++) {
    if (raw <= table[i].raw) {
      const prev = table[i - 1];
      const next = table[i];
      const span = next.raw - prev.raw;
      if (span === 0) return next.val;
      const t = (raw - prev.raw) / span;
      return prev.val + t * (next.val - prev.val);
    }
  }
  return last.val;
}

// ---------------------------------------------------------------------------
// Yaesu SWR calibration tables (from Hamlib source + community measurements)
// ---------------------------------------------------------------------------

/** Hamlib default SWR cal — 5 points, based on FT-991 testing by Adam M7OTP. */
export const YAESU_DEFAULT_SWR_CAL: readonly CalPoint[] = [
  { raw: 12, val: 1.0 },
  { raw: 39, val: 1.35 },
  { raw: 65, val: 1.5 },
  { raw: 89, val: 2.0 },
  { raw: 242, val: 5.0 },
];

/** FTDX-10 / FT-710 / FTDX-101D SWR cal — 8 points, tested by G3VPX. */
export const YAESU_FTDX10_SWR_CAL: readonly CalPoint[] = [
  { raw: 0, val: 1.0 },
  { raw: 26, val: 1.2 },
  { raw: 52, val: 1.5 },
  { raw: 89, val: 2.0 },
  { raw: 126, val: 3.0 },
  { raw: 173, val: 4.0 },
  { raw: 236, val: 5.0 },
  { raw: 255, val: 25.0 },
];

// ---------------------------------------------------------------------------
// Yaesu RF-Power calibration tables (from Hamlib source / FLRig)
// ---------------------------------------------------------------------------

/** FT-991 / FT-891 power cal — 7 points, watts. */
export const YAESU_FT991_POWER_CAL: readonly CalPoint[] = [
  { raw: 0, val: 0.0 },
  { raw: 10, val: 0.8 },
  { raw: 50, val: 8.0 },
  { raw: 100, val: 26.0 },
  { raw: 150, val: 54.0 },
  { raw: 200, val: 92.0 },
  { raw: 250, val: 140.0 },
];

/** FTDX-10 / FT-710 power cal — 5 points, watts. */
export const YAESU_FTDX10_POWER_CAL: readonly CalPoint[] = [
  { raw: 27, val: 5.0 },
  { raw: 94, val: 25.0 },
  { raw: 147, val: 50.0 },
  { raw: 176, val: 75.0 },
  { raw: 205, val: 100.0 },
];

/** FTDX-101D power cal — 6 points, watts. */
export const YAESU_FTDX101D_POWER_CAL: readonly CalPoint[] = [
  { raw: 0, val: 0.0 },
  { raw: 38, val: 5.0 },
  { raw: 94, val: 25.0 },
  { raw: 147, val: 50.0 },
  { raw: 176, val: 75.0 },
  { raw: 205, val: 100.0 },
];

/** FTDX-101MP power cal — 13 points, watts. */
export const YAESU_FTDX101MP_POWER_CAL: readonly CalPoint[] = [
  { raw: 0, val: 0.0 },
  { raw: 30, val: 5.0 },
  { raw: 69, val: 20.0 },
  { raw: 98, val: 40.0 },
  { raw: 119, val: 60.0 },
  { raw: 139, val: 80.0 },
  { raw: 160, val: 100.0 },
  { raw: 173, val: 120.0 },
  { raw: 185, val: 140.0 },
  { raw: 198, val: 160.0 },
  { raw: 210, val: 180.0 },
  { raw: 225, val: 200.0 },
  { raw: 255, val: 210.0 },
];

/** Hamlib default power cal — 3 points, watts (used when no model-specific table). */
export const YAESU_DEFAULT_POWER_CAL: readonly CalPoint[] = [
  { raw: 0, val: 0.0 },
  { raw: 148, val: 50.0 },
  { raw: 255, val: 100.0 },
];

// ---------------------------------------------------------------------------
// Yaesu S-meter (STR) calibration tables
// All values are dB offset relative to S9.
// ---------------------------------------------------------------------------

/** FT-991 / FT-891 / FT-710 / FT-950 S-meter — 16 points. */
export const YAESU_FT991_STR_CAL: readonly CalPoint[] = [
  { raw: 0, val: -54 },
  { raw: 12, val: -48 },
  { raw: 27, val: -42 },
  { raw: 40, val: -36 },
  { raw: 55, val: -30 },
  { raw: 65, val: -24 },
  { raw: 80, val: -18 },
  { raw: 95, val: -12 },
  { raw: 112, val: -6 },
  { raw: 130, val: 0 },
  { raw: 150, val: 10 },
  { raw: 172, val: 20 },
  { raw: 190, val: 30 },
  { raw: 220, val: 40 },
  { raw: 240, val: 50 },
  { raw: 255, val: 60 },
];

/** FTDX-101D S-meter — 12 points. */
export const YAESU_FTDX101D_STR_CAL: readonly CalPoint[] = [
  { raw: 0, val: -60 },
  { raw: 17, val: -54 },
  { raw: 25, val: -48 },
  { raw: 34, val: -42 },
  { raw: 51, val: -36 },
  { raw: 68, val: -30 },
  { raw: 85, val: -24 },
  { raw: 102, val: -18 },
  { raw: 119, val: -12 },
  { raw: 136, val: -6 },
  { raw: 160, val: 0 },
  { raw: 255, val: 60 },
];

/** Hamlib default S-meter — 11 points (based on FT-991 testing). */
export const YAESU_DEFAULT_STR_CAL: readonly CalPoint[] = [
  { raw: 0, val: -54 },
  { raw: 26, val: -42 },
  { raw: 51, val: -30 },
  { raw: 81, val: -18 },
  { raw: 105, val: -9 },
  { raw: 130, val: 0 },
  { raw: 157, val: 12 },
  { raw: 186, val: 25 },
  { raw: 203, val: 35 },
  { raw: 237, val: 50 },
  { raw: 255, val: 60 },
];

// ---------------------------------------------------------------------------
// Composite S-meter helper
// ---------------------------------------------------------------------------

/**
 * Convert a RAWSTR integer to a LevelMeterReading using an arbitrary
 * calibration table (dB offset relative to S9).
 *
 * This is the per-model replacement for the single-table
 * `yaesuRawstrToLevelMeterReading()` in meterUtils.ts.
 */
export function rawstrToLevelMeterReading(
  rawValue: number,
  strCalTable: readonly CalPoint[],
  frequencyHz: number,
): LevelMeterReading {
  const dbOffset = interpolateCalTable(rawValue, strCalTable);
  return _buildLevelMeterReading(
    rawValue,
    dbOffset,
    frequencyHz,
    's-meter',
    _formatSValue(dbOffset),
  );
}
