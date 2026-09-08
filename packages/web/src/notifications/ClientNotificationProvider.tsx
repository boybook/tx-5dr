import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  CLIENT_NOTIFICATION_SETTINGS_CHANGED_EVENT,
  getClientNotificationPreferences,
  updateClientNotificationPreferences,
  type ClientNotificationPreferences,
} from './clientNotificationPreferences';
import { NotificationSoundPlayer } from './notificationSoundPlayer';
import { useQsoNotificationController } from './useQsoNotificationController';

function useClientNotificationController() {
  const qso = useQsoNotificationController();
  const [preferences, setPreferences] = useState(getClientNotificationPreferences);
  const [player] = useState(() => new NotificationSoundPlayer());
  const soundStatus = useSyncExternalStore(player.subscribe, player.getStatus, player.getStatus);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    const refresh = () => {
      const next = getClientNotificationPreferences();
      preferencesRef.current = next;
      if (!next.replyEnabled) player.stop();
      player.setVolume(next.replyVolume);
      setPreferences(next);
    };
    window.addEventListener('storage', refresh);
    window.addEventListener(CLIENT_NOTIFICATION_SETTINGS_CHANGED_EVENT, refresh);
    player.initialize();
    refresh();
    const unlock = () => {
      const current = preferencesRef.current;
      if (current.replyEnabled) void player.unlock().then(() => player.prepare(current.replySound));
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(CLIENT_NOTIFICATION_SETTINGS_CHANGED_EVENT, refresh);
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      player.dispose();
    };
  }, [player]);

  useEffect(() => {
    player.stop();
    if (preferences.replyEnabled) void player.prepare(preferences.replySound);
  }, [player, preferences.replyEnabled, preferences.replySound]);

  const update = useCallback((patch: Partial<Omit<ClientNotificationPreferences, 'version'>>) => {
    return updateClientNotificationPreferences(patch);
  }, []);

  const setReplyEnabled = useCallback((enabled: boolean) => {
    const saved = update({ replyEnabled: enabled });
    if (saved && enabled) void player.unlock().then(() => player.prepare(preferencesRef.current.replySound));
    if (!enabled) player.stop();
    return saved;
  }, [player, update]);

  return useMemo(() => ({ preferences, qso, player, soundStatus, update, setReplyEnabled }),
    [preferences, qso, player, soundStatus, update, setReplyEnabled]);
}

const ClientNotificationContext = createContext<ReturnType<typeof useClientNotificationController> | null>(null);

export function ClientNotificationProvider({ children }: { children: ReactNode }) {
  const controller = useClientNotificationController();
  return <ClientNotificationContext.Provider value={controller}>{children}</ClientNotificationContext.Provider>;
}

export function useClientNotifications() {
  const context = useContext(ClientNotificationContext);
  if (!context) throw new Error('useClientNotifications must be used within ClientNotificationProvider');
  return context;
}
