import React, { useCallback, useMemo } from 'react';
import { addToast } from '@heroui/toast';
import { Alert, Button, Card, CardBody, Chip, Switch } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useQsoNotificationController } from '../../notifications/useQsoNotificationController';

function getStatusColor(status: 'active' | 'disabled' | 'needs-permission' | 'blocked' | 'unsupported'): 'success' | 'default' | 'warning' | 'danger' {
  switch (status) {
    case 'active':
      return 'success';
    case 'needs-permission':
      return 'warning';
    case 'blocked':
      return 'danger';
    case 'unsupported':
      return 'warning';
    default:
      return 'default';
  }
}

export const QSONotificationSettingsCard: React.FC = () => {
  const { t } = useTranslation('settings');
  const { state, enable, disable } = useQsoNotificationController();

  const statusLabel = useMemo(() => {
    switch (state.status) {
      case 'active':
        return t('qsoNotifications.status.active');
      case 'needs-permission':
        return t('qsoNotifications.status.needsPermission');
      case 'blocked':
        return t('qsoNotifications.status.blocked');
      case 'unsupported':
        return t('qsoNotifications.status.unsupported');
      default:
        return t('qsoNotifications.status.disabled');
    }
  }, [state.status, t]);

  const handleToggle = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      disable();
      return;
    }

    const result = await enable();
    if (result.ok) {
      return;
    }

    const description = result.reason === 'unsupported'
      ? t('qsoNotifications.unsupportedDescription')
      : result.reason === 'denied'
        ? t('qsoNotifications.blockedDescription')
        : t('qsoNotifications.permissionPendingDescription');

    addToast({
      title: t('qsoNotifications.toggleFailedTitle'),
      description,
      color: result.reason === 'dismissed' ? 'default' : 'warning',
      timeout: 4000,
    });
  }, [disable, enable, t]);

  const handleRequestPermission = useCallback(async () => {
    await handleToggle(true);
  }, [handleToggle]);

  return (
    <Card shadow="none" radius="lg" classNames={{ base: 'border border-divider bg-content1' }}>
      <CardBody className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-default-900">{t('qsoNotifications.title')}</h4>
              <Chip size="sm" color={getStatusColor(state.status)} variant="flat">
                {statusLabel}
              </Chip>
            </div>
            <p className="text-sm text-default-600">
              {t('qsoNotifications.description')}
            </p>
            <p className="text-xs text-default-500">
              {t('qsoNotifications.localOnly')}
            </p>
          </div>
          <Switch
            isSelected={state.preferenceEnabled}
            onValueChange={handleToggle}
          />
        </div>

        {state.status === 'needs-permission' && (
          <Alert
            color="warning"
            title={t('qsoNotifications.permissionRequiredTitle')}
            description={t('qsoNotifications.permissionRequiredDescription')}
            endContent={(
              <Button size="sm" color="warning" variant="flat" onPress={handleRequestPermission}>
                {t('qsoNotifications.requestPermission')}
              </Button>
            )}
          />
        )}

        {state.status === 'blocked' && (
          <Alert
            color="warning"
            title={t('qsoNotifications.blockedTitle')}
            description={t('qsoNotifications.blockedDescription')}
          />
        )}

        {state.status === 'unsupported' && (
          <Alert
            color="warning"
            title={t('qsoNotifications.unsupportedTitle')}
            description={t('qsoNotifications.unsupportedDescription')}
          />
        )}
      </CardBody>
    </Card>
  );
};
