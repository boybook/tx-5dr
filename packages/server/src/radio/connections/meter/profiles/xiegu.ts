import type { MeterProfile, MeterReadContext, MeterData } from '../types.js';

/**
 * Xiegu (X6100 / X6200 / G90 / X5105) meter profile.
 *
 * ## Why this profile exists
 *
 * Xiegu radios report the ALC meter with the opposite polarity to almost every
 * other rig: the number is *headroom*, not compression.  A high number means the
 * ALC is doing nothing (clean); a low number means the ALC is clamping down on an
 * overdriven signal.
 *
 * Two independent confirmations:
 *
 *  1. Xiegu's own GUI shows that number unchanged, which is why the community
 *     rule for the X6100 is "aim for 90-100", and why "100 ALC" on an X6100 is
 *     the same as "0 ALC" on an Icom or Yaesu.
 *  2. The community GUI (`x6100_gui/src/tx_info.c`) has to invert the value it
 *     receives from the baseband before drawing a conventional ALC bar:
 *
 *         void tx_info_update(float p, float s, float a) {
 *             a = 10.f - a;      // 10 = no ALC action, 0 = full ALC action
 *
 * Hamlib normalises the same raw reading into 0..1, so under the stock
 * `defaultHamlibProfile` rule (`alert = alcValue >= 1.0`) TX-5DR warns on every
 * *clean* Xiegu transmission and only falls silent once the operator overdrives
 * the radio - exactly the wrong way round, and the reason "adjusting the levels
 * never clears the warning".
 *
 * ## What this profile does
 *
 *  - `percent` keeps the radio's own number (100 = clean), so what TX-5DR shows
 *    matches the number on the radio's own screen.
 *  - `alert` fires only when the ALC is genuinely clamping, i.e. when the radio's
 *    number has fallen below `1 - ALERT_AT_ACTION` of full scale.
 *
 * Everything else (S-meter, SWR, power) still comes from the default Hamlib
 * profile: only the ALC polarity differs on these radios.
 */
const XIEGU_MODEL_RE = /xiegu|x6100|x6200|x5105|\bg90\b/i;

/**
 * Fraction of ALC *action* at which the operator is compressing hard enough to
 * be worth a warning.  0.5 means the radio's own number has to fall below 50 %
 * of full scale before the warning appears: a properly driven Xiegu sits at
 * 90-100, so this stays quiet while clean and still flags a real overdrive.
 * It is a policy knob, not a protocol constant - raise it to be more forgiving.
 */
const ALERT_AT_ACTION = 0.5;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Convert a Xiegu rig's Hamlib ALC level into a conventional reading.
 * Exported for the unit tests.
 *
 * @param level Hamlib `getLevel('ALC')` result, normalised 0..1 where 1 = clean.
 * @returns `percent` is the radio's own (inverted) number; `alert` reports real
 *          ALC compression rather than the radio's headroom.
 */
export function xieguAlcReading(level: number): {
  raw: number;
  percent: number;
  alert: boolean;
  unit: 'percent';
} {
  const headroom = clamp01(level);     // 1 = no ALC action, 0 = full ALC action
  const action = 1 - headroom;         // conventional ALC action, 0..1
  return {
    raw: Math.round(headroom * 255),
    percent: Math.round(headroom * 1000) / 10,  // radio's own scale: 100 = clean
    alert: action >= ALERT_AT_ACTION,
    unit: 'percent',
  };
}

export const xieguProfile: MeterProfile = {
  name: 'xiegu-inverted-alc',
  label: 'Xiegu (X6100/X6200/G90) - ALC polarity inverted',
  priority: 20,

  matches(ctx) {
    if (!ctx.supportedLevels.has('ALC')) return false;
    const haystack = `${ctx.manufacturer ?? ''} ${ctx.modelName ?? ''}`;
    return XIEGU_MODEL_RE.test(haystack);
  },

  async readAlc(ctx: MeterReadContext): Promise<MeterData['alc']> {
    const level = await ctx.getLevel('ALC');
    if (level === null) return null;
    return xieguAlcReading(level);
  },
};
