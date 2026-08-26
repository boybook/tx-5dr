import { describe, expect, it } from 'vitest';
import { AuthorizationLease } from './AuthorizationLease.js';
import { LaneFrequencyController } from './LaneFrequencyController.js';
import { PostCompletionRecoveryLease } from './PostCompletionRecoveryLease.js';

describe('parallel QSO toolkit controllers', () => {
  it('expires and reauthorizes a mode-relative manual authorization', () => {
    const lease = new AuthorizationLease({ authorizationId: 'a', authorizedAtCycle: 10, expiresAfterReceiveCycles: 4 });
    expect(lease.isFresh(13)).toBe(true);
    expect(lease.isFresh(14)).toBe(false);
    lease.reauthorize('b', 14);
    expect(lease.authorizationId).toBe('b');
    expect(lease.isFresh(17)).toBe(true);
  });

  it('keeps manual lane frequency until reset to automatic', () => {
    let automatic = 1200;
    const frequency = new LaneFrequencyController(() => automatic);
    expect(frequency.frequencyHz).toBe(1200);
    frequency.setManual(1700);
    automatic = 1300;
    expect(frequency.frequencyHz).toBe(1700);
    frequency.useAutomatic();
    expect(frequency.frequencyHz).toBe(1300);
  });

  it('matches protocol-owned recovery actions within a bounded lease', () => {
    const lease = new PostCompletionRecoveryLease<string, { id: string }>(2, [{
      matches: (message) => message === 'repeat',
      action: { id: 'reply' },
    }]);
    expect(lease.observe(['repeat'])).toEqual([{ id: 'reply' }]);
    lease.advanceReceiveCycle();
    lease.advanceReceiveCycle();
    expect(lease.active).toBe(false);
    expect(lease.observe(['repeat'])).toEqual([]);
  });
});
