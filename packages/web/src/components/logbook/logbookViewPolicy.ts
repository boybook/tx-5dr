import type { LogbookHealth } from '@tx5dr/contracts';

const LOGBOOK_HEALTH_ERROR_CODES = new Set([
  'LOGBOOK_LOADING',
  'LOGBOOK_READ_ONLY',
  'LOGBOOK_UNAVAILABLE',
  'LOGBOOK_WRITE_STATE_UNCERTAIN',
]);

export interface LogbookViewPolicy {
  writable: boolean;
  showHealthBanner: boolean;
  showLoadError: boolean;
}

export function resolveLogbookViewPolicy(
  health: LogbookHealth | null | undefined,
  loadError: string | null | undefined,
): LogbookViewPolicy {
  return {
    // Do not expose mutation controls until the authoritative health snapshot arrives.
    writable: health?.writable === true,
    showHealthBanner: health !== null && health !== undefined && health.state !== 'healthy',
    showLoadError: Boolean(loadError),
  };
}

export function isLogbookHealthOperationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && LOGBOOK_HEALTH_ERROR_CODES.has(code);
}
