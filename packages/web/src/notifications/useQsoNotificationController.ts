import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BrowserNotificationPermission,
  getNotificationPermissionState,
  isNotificationSecureContext,
  isNotificationSupported,
  requestNotificationPermission,
} from './notificationDriver';
import {
  getQsoNotificationPreferences,
  QSO_NOTIFICATION_SETTINGS_CHANGED_EVENT,
  saveQsoNotificationPreferences,
} from './qsoNotificationPreferences';
import {
  resolveQsoNotificationRuntimeState,
  type QsoNotificationRuntimeState,
} from './qsoNotificationState';

type EnableQsoNotificationResult =
  | { ok: true; permission: BrowserNotificationPermission }
  | { ok: false; reason: 'unsupported' | 'denied' | 'dismissed' };

function readState(): QsoNotificationRuntimeState {
  const preferences = getQsoNotificationPreferences();
  return resolveQsoNotificationRuntimeState({
    supported: isNotificationSupported(),
    secureContext: isNotificationSecureContext(),
    permission: getNotificationPermissionState(),
    preferenceEnabled: preferences.enabled,
  });
}

export function useQsoNotificationController() {
  const [state, setState] = useState<QsoNotificationRuntimeState>(() => readState());

  const refresh = useCallback(() => {
    setState(readState());
  }, []);

  useEffect(() => {
    let disposed = false;
    let permissionStatus: PermissionStatus | null = null;

    const handleStateChange = () => {
      if (!disposed) {
        refresh();
      }
    };

    window.addEventListener('storage', handleStateChange);
    window.addEventListener(QSO_NOTIFICATION_SETTINGS_CHANGED_EVENT, handleStateChange);
    window.addEventListener('focus', handleStateChange);
    document.addEventListener('visibilitychange', handleStateChange);

    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'notifications' } as never).then((result) => {
        if (disposed) return;
        permissionStatus = result;
        permissionStatus.addEventListener('change', handleStateChange);
      }).catch(() => {
        // Some runtimes expose Notification but not permission querying.
      });
    }

    return () => {
      disposed = true;
      window.removeEventListener('storage', handleStateChange);
      window.removeEventListener(QSO_NOTIFICATION_SETTINGS_CHANGED_EVENT, handleStateChange);
      window.removeEventListener('focus', handleStateChange);
      document.removeEventListener('visibilitychange', handleStateChange);
      permissionStatus?.removeEventListener('change', handleStateChange);
    };
  }, [refresh]);

  const setPreferenceEnabled = useCallback((enabled: boolean) => {
    saveQsoNotificationPreferences({ enabled });
    refresh();
  }, [refresh]);

  const disable = useCallback(() => {
    setPreferenceEnabled(false);
  }, [setPreferenceEnabled]);

  const enable = useCallback(async (): Promise<EnableQsoNotificationResult> => {
    if (!state.supported || !state.secureContext) {
      return { ok: false, reason: 'unsupported' };
    }

    if (state.permission === 'granted') {
      setPreferenceEnabled(true);
      return { ok: true, permission: 'granted' };
    }

    if (state.permission === 'denied') {
      return { ok: false, reason: 'denied' };
    }

    const permission = await requestNotificationPermission();
    refresh();

    if (permission === 'granted') {
      setPreferenceEnabled(true);
      return { ok: true, permission };
    }

    if (permission === 'denied') {
      return { ok: false, reason: 'denied' };
    }

    return { ok: false, reason: 'dismissed' };
  }, [refresh, setPreferenceEnabled, state.permission, state.secureContext, state.supported]);

  return useMemo(() => ({
    state,
    refresh,
    enable,
    disable,
    setPreferenceEnabled,
  }), [disable, enable, refresh, setPreferenceEnabled, state]);
}
