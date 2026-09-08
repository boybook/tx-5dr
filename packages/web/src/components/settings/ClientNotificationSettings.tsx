import { useState } from 'react';
import { Button, Select, SelectItem, Slider, Switch, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay, faSliders, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useClientNotifications } from '../../notifications/ClientNotificationProvider';
import { NOTIFICATION_SOUND_IDS, type NotificationSoundId } from '../../notifications/clientNotificationPreferences';
import { openSystemNotificationSettings } from '../../notifications/notificationDriver';

export function ClientNotificationSettings() {
  const { t } = useTranslation('settings');
  const { preferences, qso, player, soundStatus, update, setReplyEnabled } = useClientNotifications();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const qsoState = qso.state;

  const saveResult = (saved: boolean) => setError(saved ? null : t('clientNotifications.storageError'));
  const toggleQso = async (enabled: boolean) => {
    setError(null);
    if (!enabled) { saveResult(qso.disable()); return; }
    setPending(true);
    try {
      const result = await qso.enable();
      if (!result.ok) {
        const key = result.reason === 'storage' ? 'clientNotifications.storageError'
          : result.reason === 'denied' ? 'qsoNotifications.blockedDescription'
            : result.reason === 'unsupported' ? 'qsoNotifications.unsupportedDescription'
              : 'qsoNotifications.permissionPendingDescription';
        setError(t(key));
      }
    } finally { setPending(false); }
  };
  const preview = async () => {
    setPreviewing(true);
    try { await player.preview(preferences.replySound); }
    finally { setPreviewing(false); }
  };
  const needsAudio = preferences.replyEnabled && soundStatus !== 'ready';

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('qsoNotifications.title')}</div>
          <div className={`text-xs ${qsoState.preferenceEnabled && !qsoState.isEffectivelyEnabled ? 'text-warning-600' : 'text-default-500'}`}>
            {t(`qsoNotifications.status.${qsoState.status === 'needs-permission' ? 'needsPermission' : qsoState.status}`)}
          </div>
        </div>
        <Switch
          size="sm"
          className="shrink-0"
          isSelected={qsoState.preferenceEnabled}
          isDisabled={pending || (qsoState.status === 'unsupported' && !qsoState.preferenceEnabled)}
          onValueChange={toggleQso}
          aria-label={t('qsoNotifications.title')}
        />
      </div>
      {qsoState.status === 'needs-permission' && (
        <Button size="sm" variant="flat" onPress={() => void toggleQso(true)} isLoading={pending}>
          {t('qsoNotifications.requestPermission')}
        </Button>
      )}
      {qsoState.status === 'blocked' && (
        <div className="space-y-2 text-xs text-warning-600">
          <p>{t('qsoNotifications.blockedDescription')}</p>
          {typeof window !== 'undefined' && window.Tx5drAndroidNotifications?.openSettings && (
            <Button size="sm" variant="flat" onPress={() => { openSystemNotificationSettings(); }}>
              {t('qsoNotifications.openSettings')}
            </Button>
          )}
        </div>
      )}
      {qsoState.status === 'unsupported' && (
        <p className="text-xs text-default-500">{t('qsoNotifications.unsupportedDescription')}</p>
      )}
      <div className="border-t border-divider pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 text-sm font-medium">{t('clientNotifications.replyTitle')}</span>
          <Tooltip content={t('clientNotifications.soundSettings')}>
            <Button
              isIconOnly size="sm" variant="light" className="h-8 w-8 min-w-8 shrink-0 text-default-500"
              aria-label={t('clientNotifications.soundSettings')} aria-expanded={expanded}
              onPress={() => setExpanded(value => !value)}
            ><FontAwesomeIcon icon={faSliders} /></Button>
          </Tooltip>
          <Switch
            size="sm" className="shrink-0" isSelected={preferences.replyEnabled}
            isDisabled={soundStatus === 'unsupported' && !preferences.replyEnabled}
            onValueChange={value => saveResult(setReplyEnabled(value))}
            aria-label={t('clientNotifications.replyTitle')}
          />
        </div>
      </div>
      {(needsAudio || soundStatus === 'error' || soundStatus === 'unsupported') && (
        <div className="flex items-center justify-between gap-2 text-xs text-warning-600" role="status">
          <span>{t(`clientNotifications.audioStatus.${soundStatus}`)}</span>
          {soundStatus !== 'unsupported' && (
            <Tooltip content={t('clientNotifications.activateAudio')}>
              <Button isIconOnly size="sm" variant="flat" aria-label={t('clientNotifications.activateAudio')}
                onPress={() => { void player.unlock().then(() => player.prepare(preferences.replySound)); }}>
                <FontAwesomeIcon icon={faVolumeHigh} />
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      {expanded && (
        <div className="flex flex-col gap-3 border-t border-divider pt-3">
          <div className="flex items-end gap-2">
            <Select
              size="sm" className="min-w-0 flex-1" label={t('clientNotifications.sound')}
              selectedKeys={[preferences.replySound]} disallowEmptySelection
              onSelectionChange={keys => {
                const sound = Array.from(keys)[0] as NotificationSoundId | undefined;
                if (sound) saveResult(update({ replySound: sound }));
              }}
            >
              {NOTIFICATION_SOUND_IDS.map(sound => (
                <SelectItem key={sound}>{t(`clientNotifications.sounds.${sound}`)}</SelectItem>
              ))}
            </Select>
            <Tooltip content={t('clientNotifications.preview')}>
              <Button isIconOnly size="sm" variant="flat" className="mb-2 h-8 w-8 min-w-8"
                aria-busy={previewing} isDisabled={soundStatus === 'unsupported'}
                aria-label={t('clientNotifications.preview')} onPress={() => void preview()}>
                <FontAwesomeIcon icon={faPlay} className={previewing ? 'animate-pulse' : ''} />
              </Button>
            </Tooltip>
          </div>
          <Slider
            size="sm" label={t('clientNotifications.volume')} minValue={0} maxValue={100} step={1}
            value={Math.round(preferences.replyVolume * 100)}
            onChange={value => saveResult(update({ replyVolume: (Array.isArray(value) ? value[0] : value) / 100 }))}
          />
        </div>
      )}
      {error && <p className="text-xs text-danger-600" role="alert">{error}</p>}
    </div>
  );
}
