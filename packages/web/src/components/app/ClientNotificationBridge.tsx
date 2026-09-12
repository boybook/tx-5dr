import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConnection, useOperators, useRadioModeState, useSlotPacks } from '../../store/radioStore';
import { buildQsoNotificationSummary, getNotificationPermissionState, isDocumentInBackground, showSystemNotification } from '../../notifications/notificationDriver';
import { useClientNotifications } from '../../notifications/ClientNotificationProvider';
import { getClientNotificationPreferences } from '../../notifications/clientNotificationPreferences';
import { subscribeClientNotificationEvents } from '../../notifications/clientNotificationEvents';
import { getHiddenOperatorIds } from '../../utils/operatorPreferences';

export function ClientNotificationBridge() {
  const { t } = useTranslation('toast');
  const { state: connection } = useConnection();
  const { operators } = useOperators();
  const radio = useRadioModeState();
  const { state: slots } = useSlotPacks();
  const { player } = useClientNotifications();
  const current = useRef({ operators, radio, slots, t });
  current.current = { operators, radio, slots, t };

  useEffect(() => {
    const client = connection.radioService?.wsClientInstance;
    if (!client) return;
    const notifiedIds = new Set<string>();
    return subscribeClientNotificationEvents(client, () => {
      const value = current.current;
      const hidden = new Set(getHiddenOperatorIds());
      return {
        callsigns: value.operators.filter(operator => !hidden.has(operator.id)).map(operator => operator.context.myCall),
        mode: value.radio.currentMode?.name ?? null,
        replyEnabled: getClientNotificationPreferences().replyEnabled,
        slotPacks: value.slots.slotPacks,
        syncing: value.slots.isSyncing,
      };
    }, event => {
      const preferences = getClientNotificationPreferences();
      if (event.type === 'replyReceived') {
        if (preferences.replyEnabled) player.play(preferences.replySound);
        return;
      }
      const record = event.record;
      if (!preferences.qsoEnabled || getNotificationPermissionState() !== 'granted'
          || !isDocumentInBackground() || notifiedIds.has(record.id)) return;
      const notification = showSystemNotification({
        title: current.current.t('serverMessage.qsoLogged.title'),
        body: buildQsoNotificationSummary(record),
        tag: `qso-${record.id}`,
      });
      if (!notification) return;
      notifiedIds.add(record.id);
      if (notifiedIds.size > 500) notifiedIds.delete(notifiedIds.values().next().value!);
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    });
  }, [connection.radioService, player]);

  return null;
}
