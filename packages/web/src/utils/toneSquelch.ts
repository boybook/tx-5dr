import type { PresetFrequency } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';

export const CTCSS_TONE_TENTHS_HZ_OPTIONS = [
  670, 693, 719, 744, 770, 797, 825, 854, 885, 915,
  948, 974, 1000, 1035, 1072, 1109, 1148, 1188, 1230, 1273,
  1318, 1365, 1413, 1462, 1514, 1567, 1598, 1622, 1655, 1679,
  1713, 1738, 1773, 1799, 1835, 1862, 1899, 1928, 1966, 1995,
  2035, 2065, 2107, 2181, 2257, 2291, 2336, 2418, 2503, 2541,
] as const;

export const DCS_CODE_OPTIONS = [
  23, 25, 26, 31, 32, 36, 43, 47, 51, 53, 54, 65, 71, 72, 73, 74,
  114, 115, 116, 122, 125, 131, 132, 134, 143, 145, 152, 155, 156,
  162, 165, 172, 174, 205, 212, 223, 225, 226, 243, 244, 245, 246,
  251, 252, 255, 261, 263, 265, 266, 271, 274, 306, 311, 315, 325,
  331, 332, 343, 346, 351, 356, 364, 365, 371, 411, 412, 413, 423,
  431, 432, 445, 446, 452, 454, 455, 462, 464, 465, 466, 503, 506,
  516, 523, 526, 532, 546, 565, 606, 612, 624, 627, 631, 632, 654,
  662, 664, 703, 712, 723, 731, 732, 734, 743, 754,
] as const;

export function formatCtcssTone(tenthsHz: number): string {
  return `${(tenthsHz / 10).toFixed(1)} Hz`;
}

export function formatDcsCode(code: number): string {
  return code.toString().padStart(3, '0');
}

export function formatToneSquelch(
  preset: Pick<PresetFrequency, 'toneMode' | 'ctcssToneTenthsHz' | 'dcsCode'>,
  t: TFunction,
  options: { showNone?: boolean } = {},
): string {
  if (preset.toneMode === 'ctcss' && preset.ctcssToneTenthsHz) {
    return `CTCSS ${formatCtcssTone(preset.ctcssToneTenthsHz)}`;
  }
  if (preset.toneMode === 'dcs' && preset.dcsCode) {
    return `DCS ${formatDcsCode(preset.dcsCode)}`;
  }
  if (options.showNone === false) {
    return '';
  }
  return t('common:freqPresets.toneSquelchOptions.none');
}
