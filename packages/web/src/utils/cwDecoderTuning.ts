export const CW_DECODER_TARGET_MIN_HZ = 100;
export const CW_DECODER_TARGET_MAX_HZ = 1500;
export const CW_DECODER_FILTER_MIN_WIDTH_HZ = 100;
export const CW_DECODER_FILTER_MAX_WIDTH_HZ = 800;
export const CW_DECODER_TARGET_TUNING_STEP_HZ = 5;
export const CW_DECODER_FILTER_WIDTH_TUNING_STEP_HZ = 25;
export const CW_DECODER_TUNING_STEP_HZ = CW_DECODER_FILTER_WIDTH_TUNING_STEP_HZ;
export const CW_DECODER_FILTER_WIDTH_OPTIONS = [100, 150, 250, 500, 800] as const;

export function snapCWDecoderTuningValue(value: number, stepHz = CW_DECODER_TUNING_STEP_HZ): number {
  const step = Number.isFinite(stepHz) && stepHz > 0 ? stepHz : 1;
  return Math.round(value / step) * step;
}

export function clampCWDecoderTargetFreq(value: number): number {
  const snapped = snapCWDecoderTuningValue(value, CW_DECODER_TARGET_TUNING_STEP_HZ);
  return Math.max(CW_DECODER_TARGET_MIN_HZ, Math.min(CW_DECODER_TARGET_MAX_HZ, snapped));
}

export function clampCWDecoderFilterWidth(value: number): number {
  const snapped = snapCWDecoderTuningValue(value, CW_DECODER_FILTER_WIDTH_TUNING_STEP_HZ);
  return Math.max(CW_DECODER_FILTER_MIN_WIDTH_HZ, Math.min(CW_DECODER_FILTER_MAX_WIDTH_HZ, snapped));
}
