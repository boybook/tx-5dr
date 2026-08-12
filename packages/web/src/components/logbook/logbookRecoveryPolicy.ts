import type { LogbookBackupStatus } from '@tx5dr/contracts';

export interface LogbookPageParameters {
  operatorId: string;
  logBookId: string;
  valid: boolean;
}

export interface PersistentLogbookWriteFailure {
  message: string;
  occurredAt: number;
  unsavedCount?: number;
}

export function resolveLogbookPageParameters(search: string): LogbookPageParameters {
  const params = new URLSearchParams(search);
  const operatorId = params.get('operatorId')?.trim() ?? '';
  const logBookId = params.get('logBookId')?.trim() ?? '';
  return {
    operatorId,
    logBookId,
    valid: Boolean(operatorId || logBookId),
  };
}

export function shouldOpenLogbookRecovery(hash: string): boolean {
  return hash === '#backup';
}

export function canConfirmLogbookRestore(
  logBookId: string,
  confirmation: string,
  riskAccepted: boolean,
  hasPreflight: boolean,
): boolean {
  return hasPreflight && riskAccepted && confirmation === logBookId;
}

export function resolvePersistentWriteFailure(
  current: PersistentLogbookWriteFailure | null,
  status: Pick<LogbookBackupStatus, 'mainHealth' | 'unsaved'>,
  fallbackMessage: string,
  now = Date.now(),
): PersistentLogbookWriteFailure | null {
  const unsaved = status.unsaved ?? [];
  if (unsaved.length > 0) {
    return {
      message: current?.message ?? fallbackMessage,
      occurredAt: current?.occurredAt ?? unsaved[unsaved.length - 1]?.createdAt ?? now,
      unsavedCount: unsaved.length,
    };
  }

  // A health refresh must not hide the incident while the logbook is still unsafe.
  return status.mainHealth.writable ? null : current;
}
