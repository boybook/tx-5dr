export const MAX_RENDERER_FILE_SAVE_BYTES = 256 * 1024 * 1024;

export function sanitizeRendererSaveFileName(value: unknown, fallback = 'download.bin'): string {
  if (typeof value !== 'string') return fallback;
  const withoutControlCharacters = [...value]
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character)
    .join('');
  const sanitized = withoutControlCharacters
    .trim()
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}

export function copyRendererFileBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error('INVALID_RENDERER_FILE_DATA');
  }
  if (value.byteLength > MAX_RENDERER_FILE_SAVE_BYTES) {
    throw new Error('RENDERER_FILE_TOO_LARGE');
  }
  return Buffer.from(value);
}
