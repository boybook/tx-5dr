import type { TFunction } from 'i18next';

const RTTY_CODE_PATTERN = /\bRTTY_[A-Z_]+\b/;

/** User-facing text for a failed RTTY request: a known `RTTY_*` code is translated. */
export function describeRttyError(error: unknown, t: TFunction): string {
  const record = (error ?? {}) as { code?: unknown; message?: unknown; userMessage?: unknown };
  const candidates = [record.code, record.message, record.userMessage, String(error)];
  for (const candidate of candidates) {
    const match = typeof candidate === 'string' ? candidate.match(RTTY_CODE_PATTERN) : null;
    if (match) return t(`radio:rtty.tx.error.${match[0]}`, match[0]);
  }
  if (typeof record.userMessage === 'string' && record.userMessage) return record.userMessage;
  if (typeof record.message === 'string' && record.message) return record.message;
  return String(error);
}
