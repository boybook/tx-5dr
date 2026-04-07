import React, { useCallback } from 'react';
import { Button } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBell, faBellSlash } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useQsoNotificationController } from '../../notifications/useQsoNotificationController';

export const QSONotificationToggleButton: React.FC = () => {
  const { t } = useTranslation(['common', 'settings']);
  const { state, enable, disable } = useQsoNotificationController();

  const handlePress = useCallback(async () => {
    if (state.preferenceEnabled) {
      disable();
      return;
    }

    const result = await enable();
    if (result.ok) {
      addToast({
        title: t('settings:qsoNotifications.toastEnabledTitle'),
        description: t('settings:qsoNotifications.toastEnabledDescription'),
        color: 'success',
        timeout: 2500,
      });
      return;
    }

    if (result.reason === 'unsupported') {
      addToast({
        title: t('settings:qsoNotifications.unsupportedTitle'),
        description: t('settings:qsoNotifications.unsupportedDescription'),
        color: 'warning',
        timeout: 4000,
      });
      return;
    }

    if (result.reason === 'denied') {
      addToast({
        title: t('settings:qsoNotifications.blockedTitle'),
        description: t('settings:qsoNotifications.blockedDescription'),
        color: 'warning',
        timeout: 4500,
      });
      return;
    }

    addToast({
      title: t('settings:qsoNotifications.permissionPendingTitle'),
      description: t('settings:qsoNotifications.permissionPendingDescription'),
      color: 'default',
      timeout: 3000,
    });
  }, [disable, enable, state.preferenceEnabled, t]);

  const isActive = state.status === 'active';
  const isBlocked = state.status === 'blocked';

  return (
    <Button
      onPress={handlePress}
      isIconOnly
      variant="light"
      size="sm"
      title={isActive ? t('common:qsoNotifications.disable') : t('common:qsoNotifications.enable')}
      aria-label={isActive ? t('common:qsoNotifications.disable') : t('common:qsoNotifications.enable')}
      className={isActive ? 'text-success-600' : (isBlocked ? 'text-warning-600' : '')}
    >
      <FontAwesomeIcon
        icon={state.preferenceEnabled ? faBell : faBellSlash}
        className={`text-sm ${isActive ? 'text-success-500' : (isBlocked ? 'text-warning-500' : 'text-default-400')}`}
      />
    </Button>
  );
};
