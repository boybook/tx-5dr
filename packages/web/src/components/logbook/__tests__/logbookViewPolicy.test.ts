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
      showLogbookContent: true,
      showUnavailableRecovery: false,
      operationBusy: false,
      canOpenRecovery: false,
    });
  });

  it('allows degraded-but-writable logbooks while disabling unknown or non-writable state', () => {
    expect(resolveLogbookViewPolicy(health({ state: 'degraded' }), null).writable).toBe(true);
    expect(resolveLogbookViewPolicy(health({ state: 'unavailable', readable: false, writable: false }), null).writable).toBe(false);
    expect(resolveLogbookViewPolicy(null, null).writable).toBe(false);
  });

  it('blocks mutations while a recovery operation is queued or running', () => {
    const queued = resolveLogbookViewPolicy(health(), null, {
      operation: { state: 'queued' },
      capabilities: { canCreate: true },
    });
    const running = resolveLogbookViewPolicy(health(), null, {
      operation: { state: 'running' },
      capabilities: { canCreate: true },
    });

    expect(queued).toMatchObject({ writable: false, operationBusy: true });
    expect(running).toMatchObject({ writable: false, operationBusy: true });
  });

  it('projects recovery entry visibility only from server capabilities', () => {
    expect(resolveLogbookViewPolicy(health(), null, {
      capabilities: { canDownload: true },
    }).canOpenRecovery).toBe(true);
    expect(resolveLogbookViewPolicy(health(), null, {
      capabilities: {
        canCreate: false,
        canDownload: false,
        canRestore: false,
        canDownloadPreRestore: false,
      },
    }).canOpenRecovery).toBe(false);
    expect(resolveLogbookViewPolicy(health(), null, undefined).canOpenRecovery).toBe(false);
  });

  it('replaces unavailable logbook content with recovery state', () => {
    const policy = resolveLogbookViewPolicy(
      health({ state: 'unavailable', readable: false, writable: false }),
      null,
      { capabilities: { canRestore: true } },
    );

    expect(policy).toMatchObject({
      showLogbookContent: false,
      showUnavailableRecovery: true,
      canOpenRecovery: true,
    });
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
