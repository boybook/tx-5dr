import { describe, expect, it } from 'vitest';

import {
  LogBookInfoSchema,
  LogbookHealthSchema,
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
      filePath: '/tmp/N0CALL.adi',
      createdAt: 1,
      lastUsed: 2,
      isActive: true,
    };

    expect(LogBookInfoSchema.safeParse(info).success).toBe(false);
    expect(LogBookInfoSchema.parse({ ...info, health: loadingHealth }).health).toEqual(loadingHealth);
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
        error: {
          code: 'ARBITRARY_ERROR',
          message: 'Unstable error code',
          occurredAt: loadingHealth.updatedAt,
        },
      },
    }).success).toBe(false);
  });
});
