import React, { useEffect, useRef } from 'react';
import type { QSORecord } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { useConnection } from '../../store/radioStore';
import {
  buildQsoNotificationSummary,
  isDocumentInBackground,
  showSystemNotification,
} from '../../notifications/notificationDriver';
import { useQsoNotificationController } from '../../notifications/useQsoNotificationController';
import { createLogger } from '../../utils/logger';

const logger = createLogger('QSONotificationBridge');
const MAX_NOTIFIED_IDS = 500;

function trackNotificationId(cache: Set<string>, id: string): void {
  cache.add(id);
  if (cache.size <= MAX_NOTIFIED_IDS) {
    return;
  }

  const oldest = cache.values().next().value;
  if (oldest) {
    cache.delete(oldest);
  }
}

export const QSONotificationBridge: React.FC = () => {
  const { t } = useTranslation('toast');
  const connection = useConnection();
  const { state } = useQsoNotificationController();
  const notifiedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService || !state.isEffectivelyEnabled) {
      return;
    }

    const wsClient = radioService.wsClientInstance;

    const handleQsoRecordAdded = (data?: { operatorId: string; logBookId: string; qsoRecord: QSORecord }) => {
      const qsoRecord = data?.qsoRecord;
      if (!qsoRecord?.id) {
        return;
      }

      if (!isDocumentInBackground()) {
        return;
      }

      if (notifiedIdsRef.current.has(qsoRecord.id)) {
        return;
      }

      const notification = showSystemNotification({
        title: t('serverMessage.qsoLogged.title'),
        body: buildQsoNotificationSummary(qsoRecord),
        tag: `qso-${qsoRecord.id}`,
      });

      if (!notification) {
        return;
      }

      trackNotificationId(notifiedIdsRef.current, qsoRecord.id);
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    };

    wsClient.onWSEvent('qsoRecordAdded', handleQsoRecordAdded);

    return () => {
      wsClient.offWSEvent('qsoRecordAdded', handleQsoRecordAdded);
    };
  }, [connection.state.radioService, state.isEffectivelyEnabled, t]);

  useEffect(() => {
    if (state.status !== 'blocked') {
      return;
    }

    logger.info('QSO notification preference is enabled but permission is blocked');
  }, [state.status]);

  return null;
};
