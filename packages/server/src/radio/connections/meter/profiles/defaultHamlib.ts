import type { MeterProfile, MeterReadContext, MeterData } from '../types.js';
import {
  hamlibStrengthToLevelMeterReading,
  genericHamlibStrengthToLevelMeterReading,
  yaesuRawstrToLevelMeterReading,
  clampPercent,
} from '../calibration.js';

/**
 * Default Hamlib meter profile — the universal fallback.
 *
 * Uses standard `rig.getLevel()` calls and reproduces the conversion
 * logic that previously lived inline in HamlibConnection.
 */
export const defaultHamlibProfile: MeterProfile = {
  name: 'default-hamlib',
  label: 'Default Hamlib getLevel',
  priority: 0,

  matches(): boolean {
    return true;
  },

  // -- ALC ------------------------------------------------------------------

  async readAlc(ctx: MeterReadContext): Promise<MeterData['alc']> {
    if (!ctx.supportedLevels.has('ALC')) return null;
    const alcValue = await ctx.getLevel('ALC');
    if (alcValue === null) return null;

    const raw = Math.round(alcValue * 255);
    const percent = alcValue * 100;
    const alert = alcValue >= 1.0;
    return { raw, percent, alert };
  },

  // -- SWR ------------------------------------------------------------------

  async readSwr(ctx: MeterReadContext): Promise<MeterData['swr']> {
    if (!ctx.supportedLevels.has('SWR')) return null;
    const swrValue = await ctx.getLevel('SWR');
    if (swrValue === null) return null;

    const raw = Math.round(Math.min(swrValue / 10, 1) * 255);
    const alert = swrValue > 2.0;
    return { raw, swr: swrValue, alert };
  },

  // -- Power ----------------------------------------------------------------

  async readPower(ctx: MeterReadContext): Promise<MeterData['power']> {
    const hasMeter = ctx.supportedLevels.has('RFPOWER_METER');
    const hasWatts = ctx.supportedLevels.has('RFPOWER_METER_WATTS');
    if (!hasMeter && !hasWatts) return null;

    const meterValue = hasMeter ? await ctx.getLevel('RFPOWER_METER') : null;
    const meterWattsValue = hasWatts ? await ctx.getLevel('RFPOWER_METER_WATTS') : null;
    if (meterValue === null && meterWattsValue === null) return null;

    const maxWatts = ctx.txPowerMaxWatts;

    // Prefer RFPOWER_METER_WATTS (absolute watts, trustworthy).
    if (meterWattsValue !== null) {
      const percent = maxWatts && maxWatts > 0
        ? clampPercent((meterWattsValue / maxWatts) * 100)
        : (meterValue !== null && meterValue <= 1.0 ? clampPercent(meterValue * 100) : 0);
      const raw = Math.round(percent * 2.55);
      return { raw, percent, watts: meterWattsValue, maxWatts };
    }

    // RFPOWER_METER only.
    if (meterValue !== null) {
      // Some backends (e.g. IC-705) return watts instead of 0-1 fraction.
      if (meterValue > 1.0) {
        const percent = maxWatts && maxWatts > 0
          ? clampPercent((meterValue / maxWatts) * 100)
          : 0;
        const raw = Math.round(percent * 2.55);
        return { raw, percent, watts: meterValue, maxWatts };
      }
      const percent = clampPercent(meterValue * 100);
      const raw = Math.round(meterValue * 255);
      return { raw, percent, watts: null, maxWatts };
    }

    return { raw: 0, percent: 0, watts: null, maxWatts: null };
  },

  // -- Level (signal strength) ----------------------------------------------

  async readLevel(ctx: MeterReadContext): Promise<MeterData['level']> {
    const sourceLevel = ctx.levelDecodeStrategy.sourceLevel;
    if (!sourceLevel) return null;

    const rawValue = await ctx.getLevel(sourceLevel);
    if (rawValue === null) return null;

    switch (ctx.levelDecodeStrategy.name) {
      case 'icom':
        return hamlibStrengthToLevelMeterReading(rawValue, ctx.currentFrequencyHz);
      case 'yaesu':
        return yaesuRawstrToLevelMeterReading(rawValue, ctx.currentFrequencyHz);
      case 'generic':
      default:
        return genericHamlibStrengthToLevelMeterReading(rawValue, ctx.currentFrequencyHz);
    }
  },
};
