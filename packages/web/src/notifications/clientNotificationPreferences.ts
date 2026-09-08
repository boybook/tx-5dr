import { createLogger } from '../utils/logger';

const logger = createLogger('ClientNotificationPreferences');
export const CLIENT_NOTIFICATION_STORAGE_KEY = 'tx5dr_client_notification_preferences';
export const CLIENT_NOTIFICATION_SETTINGS_CHANGED_EVENT = 'clientNotificationSettingsChanged';
const LEGACY_STORAGE_KEY = 'tx5dr_qso_system_notification_preferences';

export const NOTIFICATION_SOUND_IDS = [
  'glass', 'glassLong', 'pluck', 'pluckAlt', 'confirmation', 'confirmationAlt', 'bong', 'question',
] as const;
export type NotificationSoundId = typeof NOTIFICATION_SOUND_IDS[number];

export interface ClientNotificationPreferences {
  version: 1;
  qsoEnabled: boolean;
  replyEnabled: boolean;
  replySound: NotificationSoundId;
  replyVolume: number;
}

export const DEFAULT_CLIENT_NOTIFICATION_PREFERENCES: ClientNotificationPreferences = {
  version: 1,
  qsoEnabled: false,
  replyEnabled: true,
  replySound: 'glass',
  replyVolume: 0.5,
};

export function decodeClientNotificationPreferences(value: unknown): ClientNotificationPreferences {
  const defaults = { ...DEFAULT_CLIENT_NOTIFICATION_PREFERENCES };
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return defaults;
  const input = value as Record<string, unknown>;
  return {
    version: 1,
    qsoEnabled: input.qsoEnabled === true,
    replyEnabled: typeof input.replyEnabled === 'boolean' ? input.replyEnabled : defaults.replyEnabled,
    replySound: NOTIFICATION_SOUND_IDS.includes(input.replySound as NotificationSoundId)
      ? input.replySound as NotificationSoundId : defaults.replySound,
    replyVolume: typeof input.replyVolume === 'number' && Number.isFinite(input.replyVolume)
      ? Math.min(1, Math.max(0, input.replyVolume)) : defaults.replyVolume,
  };
}

export function getClientNotificationPreferences(): ClientNotificationPreferences {
  try {
    const raw = localStorage.getItem(CLIENT_NOTIFICATION_STORAGE_KEY);
    if (raw !== null) return decodeClientNotificationPreferences(JSON.parse(raw));
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? 'null');
    return { ...DEFAULT_CLIENT_NOTIFICATION_PREFERENCES, qsoEnabled: legacy?.enabled === true };
  } catch {
    return { ...DEFAULT_CLIENT_NOTIFICATION_PREFERENCES };
  }
}

export function updateClientNotificationPreferences(patch: Partial<Omit<ClientNotificationPreferences, 'version'>>): boolean {
  const preferences = decodeClientNotificationPreferences({ ...getClientNotificationPreferences(), ...patch });
  try {
    localStorage.setItem(CLIENT_NOTIFICATION_STORAGE_KEY, JSON.stringify(preferences));
    window.dispatchEvent(new Event(CLIENT_NOTIFICATION_SETTINGS_CHANGED_EVENT));
    return true;
  } catch (error) {
    logger.warn('Failed to save client notification preferences', error);
    return false;
  }
}
