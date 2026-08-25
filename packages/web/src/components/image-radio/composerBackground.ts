export function fitComposerBackgroundSize(
  width: number,
  height: number,
  maxDimension = 1024,
  maxPixels = 1024 * 1024,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('IMAGE_DIMENSIONS_INVALID');
  const scale = Math.min(1, maxDimension / width, maxDimension / height, Math.sqrt(maxPixels / (width * height)));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
