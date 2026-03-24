import type { LevelMeterReading } from '@tx5dr/contracts';

const HF_S9_DBM = -73;    // HF: S9 = -73 dBm (< 30 MHz), IARU standard
const VHF_S9_DBM = -93;   // VHF/UHF: S9 = -93 dBm (>= 30 MHz), IARU Region 1
const DB_PER_S_UNIT = 6;
const VHF_THRESHOLD_HZ = 30_000_000; // 30 MHz boundary

/**
 * Determine S9 reference dBm based on frequency.
 * HF (<30 MHz): S9 = -73 dBm; VHF/UHF (>=30 MHz): S9 = -93 dBm.
 */
export function getS9ReferenceDbm(frequencyHz: number): number {
  return frequencyHz >= VHF_THRESHOLD_HZ ? VHF_S9_DBM : HF_S9_DBM;
}

/**
 * Convert Hamlib STRENGTH dB offset (relative to S9) to a complete LevelMeterReading.
 * Hamlib returns the signal level as dB relative to S9 (0 = S9, -6 = S8, +20 = S9+20dB).
 *
 * @param hamlibDbOffset - Value from hamlib getLevel('STRENGTH'), dB relative to S9
 * @param frequencyHz - Current radio frequency in Hz (0 = unknown = assume HF)
 */
export function hamlibStrengthToLevelMeterReading(
  hamlibDbOffset: number,
  frequencyHz: number = 0
): LevelMeterReading {
  const s9Dbm = getS9ReferenceDbm(frequencyHz);
  const s0Dbm = s9Dbm - 9 * DB_PER_S_UNIT;  // S0 reference (-127 for HF, -147 for VHF)
  const s9Plus60Dbm = s9Dbm + 60;            // upper meter limit (-13 for HF, -33 for VHF)

  const dBm = s9Dbm + hamlibDbOffset;

  // percent: map s0Dbm (0%) to s9Plus60Dbm (100%)
  const clampedDbm = Math.max(s0Dbm, Math.min(s9Plus60Dbm, dBm));
  const percent = ((clampedDbm - s0Dbm) / (s9Plus60Dbm - s0Dbm)) * 100;
  const raw = Math.round((percent / 100) * 255);

  // sUnits: 0 at S0, 9 at S9 (float, clamped to [0, 9])
  const sUnitsRaw = (dBm - s0Dbm) / DB_PER_S_UNIT;
  const sUnits = Math.max(0, Math.min(9, sUnitsRaw));

  // dbAboveS9: only set when signal exceeds S9
  const dbAboveS9 = dBm > s9Dbm ? Math.round(dBm - s9Dbm) : undefined;

  const formatted =
    dbAboveS9 !== undefined && dbAboveS9 > 0
      ? `S9+${dbAboveS9}dB`
      : `S${Math.round(sUnits)}`;

  return { raw, percent, sUnits, dbAboveS9, dBm, formatted };
}
