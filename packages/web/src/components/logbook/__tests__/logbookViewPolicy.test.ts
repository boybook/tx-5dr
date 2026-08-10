import { describe, expect, it } from 'vitest';
import type { LogbookHealth } from '@tx5dr/contracts';
import {
  isLogbookHealthOperationError,
  resolveLogbookViewPolicy,
} from '../logbookViewPolicy';

function health(overrides: Partial<LogbookHealth> = {}): LogbookHealth {
  return {
    state: 'healthy',
    readable: true,
    writable: true,
    issues: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe('logbook view policy', () => {
  it('keeps the persistent health banner visible alongside a load error', () => {
    expect(resolveLogbookViewPolicy(
      health({ state: 'read_only', writable: false }),
      'request failed',
    )).toEqual({
      writable: false,
      showHealthBanner: true,
      showLoadError: true,
    });
  });

  it('allows degraded-but-writable logbooks while disabling unknown or non-writable state', () => {
    expect(resolveLogbookViewPolicy(health({ state: 'degraded' }), null).writable).toBe(true);
    expect(resolveLogbookViewPolicy(health({ state: 'unavailable', readable: false, writable: false }), null).writable).toBe(false);
    expect(resolveLogbookViewPolicy(null, null).writable).toBe(false);
  });

  it.each([
    'LOGBOOK_LOADING',
    'LOGBOOK_READ_ONLY',
    'LOGBOOK_UNAVAILABLE',
    'LOGBOOK_WRITE_STATE_UNCERTAIN',
  ])('recognizes %s as a health operation error', (code) => {
    expect(isLogbookHealthOperationError({ code })).toBe(true);
  });

  it('does not classify ordinary write failures as health-state errors', () => {
    expect(isLogbookHealthOperationError({ code: 'LOGBOOK_WRITE_FAILED' })).toBe(false);
    expect(isLogbookHealthOperationError(new Error('failed'))).toBe(false);
  });
});
