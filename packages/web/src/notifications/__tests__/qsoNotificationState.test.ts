import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildQsoNotificationSummary,
  getNotificationPermissionState,
  isNotificationSecureContext,
  isNotificationSupported,
  showSystemNotification,
} from '../notificationDriver';
import { resolveQsoNotificationRuntimeState } from '../qsoNotificationState';

describe('qsoNotificationState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('uses the Android native bridge even when the page is not a secure context', () => {
    const shownPayloads: string[] = [];
    vi.stubGlobal('window', {
      isSecureContext: false,
      location: { hostname: '192.168.1.20' },
      Tx5drAndroidNotifications: {
        getPermission: () => 'granted',
        requestPermission: vi.fn(),
        showNotification: (payloadJson: string) => {
          shownPayloads.push(payloadJson);
          return true;
        },
      },
    });

    expect(isNotificationSupported()).toBe(true);
    expect(isNotificationSecureContext()).toBe(true);
    expect(getNotificationPermissionState()).toBe('granted');

    const handle = showSystemNotification({
      title: 'QSO logged',
      body: 'JA1ABC • PM95 • 14.074 MHz • FT8',
      tag: 'qso-1',
    });

    expect(handle).not.toBeNull();
    expect(JSON.parse(shownPayloads[0])).toMatchObject({
      title: 'QSO logged',
      body: 'JA1ABC • PM95 • 14.074 MHz • FT8',
      tag: 'qso-1',
    });
  });

  it('keeps ordinary insecure HTTP pages unsupported without the Android bridge', () => {
    vi.stubGlobal('window', {
      isSecureContext: false,
      location: { hostname: '192.168.1.20' },
    });

    expect(isNotificationSecureContext()).toBe(false);
    expect(getNotificationPermissionState()).toBe('unsupported');
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
