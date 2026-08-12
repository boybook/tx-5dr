import { describe, expect, it } from 'vitest';

import {
  CreateLogbookBackupRequestSchema,
  LogBookInfoSchema,
  LogbookHealthSchema,
  RestoreLogbookRequestSchema,
  WSMessageSchema,
  WSMessageType,
} from '../../index.js';

const loadingHealth = {
  state: 'loading' as const,
  readable: false,
  writable: false,
  issues: [],
  updatedAt: 1_775_394_000_000,
};

describe('logbook health contracts', () => {
  it('requires every logbook listing to expose health', () => {
    const info = {
      id: 'logbook-N0CALL',
      name: 'N0CALL QSO Log',
      fileName: 'N0CALL.adi',
      storageKind: 'managed' as const,
      createdAt: 1,
      lastUsed: 2,
      isActive: true,
    };

    expect(LogBookInfoSchema.safeParse(info).success).toBe(false);
    const parsed = LogBookInfoSchema.parse({ ...info, health: loadingHealth });
    expect(parsed.health).toEqual(loadingHealth);
    expect(parsed).not.toHaveProperty('filePath');
  });

  it('rejects path-bearing fields in backup and restore mutations', () => {
    expect(CreateLogbookBackupRequestSchema.safeParse({
      filePath: '/tmp/escape.adi',
    }).success).toBe(false);
    expect(RestoreLogbookRequestSchema.safeParse({
      preflightToken: 'preflight-token-1',
      confirmation: 'logbook-N0CALL',
      artifactPath: '../another.adi',
    }).success).toBe(false);
  });

  it('rejects negative affected record and byte counts', () => {
    expect(LogbookHealthSchema.safeParse({
      ...loadingHealth,
      issues: [{
        code: 'OPAQUE_RECORDS',
        message: 'One record was skipped',
        affectedRecords: -1,
        affectedBytes: -1,
        occurredAt: loadingHealth.updatedAt,
      }],
    }).success).toBe(false);
  });

  it('validates health and write-failure websocket payloads', () => {
    expect(WSMessageSchema.safeParse({
      type: WSMessageType.LOGBOOK_HEALTH_CHANGED,
      timestamp: new Date().toISOString(),
      data: { logBookId: 'logbook-N0CALL', health: loadingHealth },
    }).success).toBe(true);
    expect(WSMessageSchema.safeParse({
      type: WSMessageType.LOGBOOK_WRITE_FAILED,
      timestamp: new Date().toISOString(),
      data: {
        logBookId: 'logbook-N0CALL',
        operatorId: 'operator-1',
        attemptId: 'attempt-12345678',
        unsavedCount: 1,
        error: {
          code: 'LOGBOOK_WRITE_FAILED',
          message: 'No space left on device',
          systemCode: 'ENOSPC',
          occurredAt: loadingHealth.updatedAt,
        },
      },
    }).success).toBe(true);
    expect(WSMessageSchema.safeParse({
      type: WSMessageType.LOGBOOK_WRITE_FAILED,
      timestamp: new Date().toISOString(),
      data: {
        logBookId: 'logbook-N0CALL',
        qsoRecord: {
          id: 'private-qso',
          callsign: 'N0CALL',
          frequency: 14_074_000,
          mode: 'FT8',
          startTime: loadingHealth.updatedAt,
          messageHistory: ['CQ N0CALL AA00'],
        },
        error: {
          code: 'LOGBOOK_WRITE_FAILED',
          message: 'write failed',
          occurredAt: loadingHealth.updatedAt,
        },
      },
    }).success).toBe(false);
    expect(WSMessageSchema.safeParse({
      type: WSMessageType.LOGBOOK_WRITE_FAILED,
      timestamp: new Date().toISOString(),
      data: {
        logBookId: 'logbook-N0CALL',
        error: {
          code: 'ARBITRARY_ERROR',
          message: 'Unstable error code',
          occurredAt: loadingHealth.updatedAt,
        },
      },
    }).success).toBe(false);
  });
});
