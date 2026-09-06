import type { ImageComposerTransform } from '@tx5dr/contracts';

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

export function fitComposerImageTransform(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  fit: ImageComposerTransform['fit'],
  maxWidth = canvasWidth,
  maxHeight = canvasHeight,
): ImageComposerTransform {
  if (![sourceWidth, sourceHeight, canvasWidth, canvasHeight, maxWidth, maxHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('IMAGE_DIMENSIONS_INVALID');
  }
  const scale = fit === 'cover'
    ? Math.max(maxWidth / sourceWidth, maxHeight / sourceHeight)
    : Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const targetRatio = maxWidth / maxHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  const crop = fit === 'cover'
    ? sourceRatio > targetRatio
      ? { x: (1 - targetRatio / sourceRatio) / 2, y: 0, width: targetRatio / sourceRatio, height: 1 }
      : { x: 0, y: (1 - sourceRatio / targetRatio) / 2, width: 1, height: sourceRatio / targetRatio }
    : { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: fit === 'cover' ? (canvasWidth - maxWidth) / (2 * canvasWidth) : (canvasWidth - width) / (2 * canvasWidth),
    y: fit === 'cover' ? (canvasHeight - maxHeight) / (2 * canvasHeight) : (canvasHeight - height) / (2 * canvasHeight),
    width: (fit === 'cover' ? maxWidth : width) / canvasWidth,
    height: (fit === 'cover' ? maxHeight : height) / canvasHeight,
    rotation: 0,
    fit,
    crop,
  };
}
