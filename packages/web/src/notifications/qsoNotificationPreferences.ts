const STORAGE_KEY = 'tx5dr_qso_system_notification_preferences';

export const QSO_NOTIFICATION_SETTINGS_CHANGED_EVENT = 'qsoNotificationSettingsChanged';

export interface QsoNotificationPreferences {
  enabled: boolean;
}

export const DEFAULT_QSO_NOTIFICATION_PREFERENCES: QsoNotificationPreferences = {
  enabled: false,
};

export function getQsoNotificationPreferences(): QsoNotificationPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_QSO_NOTIFICATION_PREFERENCES };
    }

    const parsed = JSON.parse(raw);
    return {
      enabled: parsed?.enabled === true,
    };
  } catch {
    return { ...DEFAULT_QSO_NOTIFICATION_PREFERENCES };
  }
}

export function saveQsoNotificationPreferences(preferences: QsoNotificationPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent(QSO_NOTIFICATION_SETTINGS_CHANGED_EVENT));
}
