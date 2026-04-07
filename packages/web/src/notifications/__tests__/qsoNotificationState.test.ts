import { describe, expect, it } from 'vitest';
import { buildQsoNotificationSummary } from '../notificationDriver';
import { resolveQsoNotificationRuntimeState } from '../qsoNotificationState';

describe('qsoNotificationState', () => {
  it('marks granted permission with enabled preference as active', () => {
    expect(resolveQsoNotificationRuntimeState({
      supported: true,
      secureContext: true,
      permission: 'granted',
      preferenceEnabled: true,
    })).toMatchObject({
      status: 'active',
      isEffectivelyEnabled: true,
    });
  });

  it('keeps enabled preference blocked when permission is denied', () => {
    expect(resolveQsoNotificationRuntimeState({
      supported: true,
      secureContext: true,
      permission: 'denied',
      preferenceEnabled: true,
    })).toMatchObject({
      status: 'blocked',
      isBlocked: true,
      isEffectivelyEnabled: false,
    });
  });

  it('treats insecure or unsupported runtimes as unsupported', () => {
    expect(resolveQsoNotificationRuntimeState({
      supported: true,
      secureContext: false,
      permission: 'default',
      preferenceEnabled: true,
    }).status).toBe('unsupported');

    expect(resolveQsoNotificationRuntimeState({
      supported: false,
      secureContext: true,
      permission: 'unsupported',
      preferenceEnabled: false,
    }).status).toBe('unsupported');
  });

  it('keeps disabled preference as disabled even if permission was denied', () => {
    expect(resolveQsoNotificationRuntimeState({
      supported: true,
      secureContext: true,
      permission: 'denied',
      preferenceEnabled: false,
    })).toMatchObject({
      status: 'disabled',
      isBlocked: false,
    });
  });

  it('builds a compact QSO notification summary', () => {
    expect(buildQsoNotificationSummary({
      callsign: 'JA1ABC',
      grid: 'PM95',
      frequency: 14074000,
      mode: 'FT8',
      reportSent: '-08',
      reportReceived: '-12',
    })).toBe('JA1ABC • PM95 • 14.074 MHz • FT8 • -08/-12');
  });
});
