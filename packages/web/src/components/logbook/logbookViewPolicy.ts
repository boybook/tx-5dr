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
  showLogbookContent: boolean;
  showUnavailableRecovery: boolean;
  operationBusy: boolean;
  canOpenRecovery: boolean;
}

export interface LogbookRecoveryViewState {
  capabilities?: {
    canCreate?: boolean;
    canDownload?: boolean;
    canRestore?: boolean;
    canDownloadPreRestore?: boolean;
  };
  operation?: {
    state?: string;
  };
}

export function isLogbookRecoveryOperationBusy(
  recovery: LogbookRecoveryViewState | null | undefined,
): boolean {
  return recovery?.operation?.state === 'queued' || recovery?.operation?.state === 'running';
}

export function resolveLogbookViewPolicy(
  health: LogbookHealth | null | undefined,
  loadError: string | null | undefined,
  recovery?: LogbookRecoveryViewState | null,
): LogbookViewPolicy {
  const operationBusy = isLogbookRecoveryOperationBusy(recovery);
  const capabilities = recovery?.capabilities;
  const canOpenRecovery = Boolean(capabilities && Object.values(capabilities).some(Boolean));
  const unavailable = health?.state === 'unavailable';
  return {
    // Do not expose mutation controls until the authoritative health snapshot arrives.
    writable: health?.writable === true && !operationBusy,
    showHealthBanner: health !== null && health !== undefined && health.state !== 'healthy',
    showLoadError: Boolean(loadError),
    showLogbookContent: !unavailable,
    showUnavailableRecovery: unavailable,
    operationBusy,
    canOpenRecovery,
  };
}

export function isLogbookHealthOperationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && LOGBOOK_HEALTH_ERROR_CODES.has(code);
}
