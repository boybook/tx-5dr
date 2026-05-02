import React from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useUpdateNotification } from '../app/UpdateNotificationProvider';

export function SettingsButton() {
  const { t } = useTranslation('common');
  const { isUnreadUpdateAvailable, markCurrentAsRead } = useUpdateNotification();

  const handleOpenSettings = () => {
    if (isUnreadUpdateAvailable) {
      markCurrentAsRead();
      window.dispatchEvent(new CustomEvent('openSettingsModal', {
        detail: { tab: 'system', section: 'updates' },
      }));
      return;
    }

    window.dispatchEvent(new CustomEvent('openSettingsModal', { detail: { tab: 'radio' } }));
  };

  return (
    <Button
      onPress={handleOpenSettings}
      isIconOnly
      variant="light"
      size="sm"
      title={t('action.openSettings')}
      aria-label={t('action.openSettings')}
      className="relative"
    >
      <FontAwesomeIcon icon={faCog} className="text-default-400 text-sm" />
      {isUnreadUpdateAvailable && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger-500 ring-2 ring-content1" />
      )}
    </Button>
  );
}
