export const MAX_COMPOSER_BACKGROUND_SOURCE_BYTES = 64 * 1024 * 1024;

const SUPPORTED_COMPOSER_BACKGROUND_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type ComposerBackgroundFileError = 'tooLarge' | 'unsupportedFormat';

export function validateComposerBackgroundFile(file: { size: number; type: string }): ComposerBackgroundFileError | null {
  if (file.size > MAX_COMPOSER_BACKGROUND_SOURCE_BYTES) return 'tooLarge';
  if (!SUPPORTED_COMPOSER_BACKGROUND_TYPES.has(file.type.toLowerCase())) return 'unsupportedFormat';
  return null;
}

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
