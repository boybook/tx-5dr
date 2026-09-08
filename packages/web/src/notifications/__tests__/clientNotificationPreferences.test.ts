import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_NOTIFICATION_SETTINGS_CHANGED_EVENT,
  CLIENT_NOTIFICATION_STORAGE_KEY,
  DEFAULT_CLIENT_NOTIFICATION_PREFERENCES,
  decodeClientNotificationPreferences,
  getClientNotificationPreferences,
  updateClientNotificationPreferences,
} from '../clientNotificationPreferences';

describe('client notification preferences', () => {
  const storage = new Map<string, string>();
  let dispatchEvent: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    storage.clear();
    dispatchEvent = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal('window', { dispatchEvent });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads legacy QSO preference without writing, then preserves it on the first new save', () => {
    storage.set('tx5dr_qso_system_notification_preferences', '{"enabled":true}');
    expect(getClientNotificationPreferences()).toEqual({ ...DEFAULT_CLIENT_NOTIFICATION_PREFERENCES, qsoEnabled: true });
    expect(storage.has(CLIENT_NOTIFICATION_STORAGE_KEY)).toBe(false);
    expect(updateClientNotificationPreferences({ replyEnabled: true })).toBe(true);
    expect(getClientNotificationPreferences()).toMatchObject({ qsoEnabled: true, replyEnabled: true });
    expect(dispatchEvent.mock.calls[0][0].type).toBe(CLIENT_NOTIFICATION_SETTINGS_CHANGED_EVENT);
  });

  it('gives the new key precedence even when its content is corrupt', () => {
    storage.set('tx5dr_qso_system_notification_preferences', '{"enabled":true}');
    storage.set(CLIENT_NOTIFICATION_STORAGE_KEY, 'broken');
    expect(getClientNotificationPreferences()).toEqual(DEFAULT_CLIENT_NOTIFICATION_PREFERENCES);
    storage.set(CLIENT_NOTIFICATION_STORAGE_KEY, '{"version":1,"qsoEnabled":false}');
    expect(getClientNotificationPreferences().qsoEnabled).toBe(false);
  });

  it('decodes unknown fields, invalid flags, sound ids, volume and versions', () => {
    expect(decodeClientNotificationPreferences({ version: 1, qsoEnabled: 'true', replySound: 'missing', replyVolume: NaN }))
      .toEqual(DEFAULT_CLIENT_NOTIFICATION_PREFERENCES);
    expect(decodeClientNotificationPreferences({ version: 1, replyVolume: 5 }).replyVolume).toBe(1);
    expect(decodeClientNotificationPreferences({ version: 1, replyVolume: -1 }).replyVolume).toBe(0);
    expect(decodeClientNotificationPreferences({ version: 2, qsoEnabled: true })).toEqual(DEFAULT_CLIENT_NOTIFICATION_PREFERENCES);
  });

  it('updates only the requested fields and reports storage failures', () => {
    updateClientNotificationPreferences({ replyEnabled: true, replySound: 'pluck', replyVolume: 0.8 });
    updateClientNotificationPreferences({ qsoEnabled: true });
    expect(getClientNotificationPreferences()).toMatchObject({ replyEnabled: true, replySound: 'pluck', replyVolume: 0.8 });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
    dispatchEvent.mockClear();
    expect(updateClientNotificationPreferences({ replyEnabled: true })).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
