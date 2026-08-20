import { describe, expect, it } from 'vitest';
import type { ObservabilityStatus } from '@tx5dr/contracts';
import { shouldRequestObservabilityConsent } from './observabilityConsent';

function createStatus(noticeRequired: boolean): ObservabilityStatus {
  return {
    settings: { enabled: true, noticeVersion: noticeRequired ? 0 : 1 },
    effectiveEnabled: !noticeRequired,
    noticeRequired,
    endpointConfigured: true,
    queueDepth: 0,
    lastSentAt: null,
    lastError: null,
  };
}

describe('shouldRequestObservabilityConsent', () => {
  it('requests consent from an eligible administrator when the notice is pending', () => {
    expect(shouldRequestObservabilityConsent(true, createStatus(true))).toBe(true);
  });

  it('does not request consent after the notice has been acknowledged', () => {
    expect(shouldRequestObservabilityConsent(true, createStatus(false))).toBe(false);
  });

  it('does not request consent from an ineligible user or before status loads', () => {
    expect(shouldRequestObservabilityConsent(false, createStatus(true))).toBe(false);
    expect(shouldRequestObservabilityConsent(true, null)).toBe(false);
  });
});
