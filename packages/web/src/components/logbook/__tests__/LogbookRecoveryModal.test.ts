import { describe, expect, it } from 'vitest';
import type { LogbookBackupStatus } from '@tx5dr/contracts';
import {
  canConfirmLogbookRestore,
  resolvePersistentWriteFailure,
  shouldOpenLogbookRecovery,
} from '../logbookRecoveryPolicy';

describe('logbook restore confirmation', () => {
  it('requires a preview, explicit risk acceptance, and an exact logbook ID', () => {
    expect(canConfirmLogbookRestore('BA8BLK', 'BA8BLK', true, true)).toBe(true);
    expect(canConfirmLogbookRestore('BA8BLK', 'ba8blk', true, true)).toBe(false);
    expect(canConfirmLogbookRestore('BA8BLK', 'BA8BLK ', true, true)).toBe(false);
    expect(canConfirmLogbookRestore('BA8BLK', 'BA8BLK', false, true)).toBe(false);
    expect(canConfirmLogbookRestore('BA8BLK', 'BA8BLK', true, false)).toBe(false);
  });
});

describe('logbook recovery deep link', () => {
  it('opens only for the exact backup hash', () => {
    expect(shouldOpenLogbookRecovery('#backup')).toBe(true);
    expect(shouldOpenLogbookRecovery('#BACKUP')).toBe(false);
    expect(shouldOpenLogbookRecovery('#other')).toBe(false);
    expect(shouldOpenLogbookRecovery('')).toBe(false);
  });
});

describe('persistent write failure banner', () => {
  const status = (
    writable: boolean,
    unsaved: LogbookBackupStatus['unsaved'] = [],
  ): Pick<LogbookBackupStatus, 'mainHealth' | 'unsaved'> => ({
    mainHealth: {
      state: writable ? 'healthy' : 'read_only',
      readable: true,
      writable,
      issues: [],
      updatedAt: 1,
    },
    unsaved,
  });

  it('survives refreshes while the logbook remains unsafe', () => {
    const failure = { message: 'not saved', occurredAt: 10, unsavedCount: 1 };
    expect(resolvePersistentWriteFailure(failure, status(false), 'fallback', 20)).toBe(failure);
  });

  it('is reconstructed from a retained unsaved attempt', () => {
    expect(resolvePersistentWriteFailure(null, status(true, [{
      attemptId: 'attempt-1',
      operatorId: 'operator-1',
      createdAt: 15,
      callsign: 'BA8BLK',
      mode: 'FT8',
    }]), 'not saved', 20)).toEqual({
      message: 'not saved',
      occurredAt: 15,
      unsavedCount: 1,
    });
  });

  it('clears only after unsaved attempts are gone and the logbook is writable', () => {
    const failure = { message: 'not saved', occurredAt: 10, unsavedCount: 1 };
    expect(resolvePersistentWriteFailure(failure, status(true), 'fallback', 20)).toBeNull();
  });
});
