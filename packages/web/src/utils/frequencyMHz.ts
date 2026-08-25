export const MAX_MHZ_FRACTION_DIGITS = 6;
export const DEFAULT_MHZ_FRACTION_DIGITS = 3;

/** Format an integer-Hz dial frequency as MHz without losing sub-kHz precision. */
export function formatFrequencyMHz(
  frequencyHz: number,
  minimumFractionDigits = DEFAULT_MHZ_FRACTION_DIGITS,
): string {
  if (!Number.isFinite(frequencyHz)) return '';

  const boundedMinimum = Math.max(
    0,
    Math.min(MAX_MHZ_FRACTION_DIGITS, Math.trunc(minimumFractionDigits)),
  );
  const fixed = (Math.round(frequencyHz) / 1_000_000).toFixed(MAX_MHZ_FRACTION_DIGITS);
  const [whole, fraction = ''] = fixed.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const displayedFraction = trimmedFraction.padEnd(boundedMinimum, '0');

  return displayedFraction ? `${whole}.${displayedFraction}` : whole;
}

/** Parse MHz input into the application's canonical integer-Hz representation. */
export function parseFrequencyMHzToHz(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;

  const frequencyMHz = Number(normalized);
  if (!Number.isFinite(frequencyMHz) || frequencyMHz <= 0) return null;

  const frequencyHz = Math.round(frequencyMHz * 1_000_000);
  return Number.isSafeInteger(frequencyHz) && frequencyHz > 0 ? frequencyHz : null;
}
