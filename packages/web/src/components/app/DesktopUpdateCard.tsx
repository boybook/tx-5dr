import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, CardBody, Chip } from '@heroui/react';
import { api } from '@tx5dr/core';
import type { SystemUpdateStatus } from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger';
import type { DesktopUpdateStatus } from '../../types/electron';
import { useUpdateNotification, type UpdateStatusWithDownloads } from './UpdateNotificationProvider';

const logger = createLogger('DesktopUpdateCard');
const DESKTOP_UPDATE_COMMITS_URL = 'https://github.com/boybook/tx-5dr/commits/main';

const CARD_BODY_CLASS = 'px-6 py-5 space-y-4';
const CARD_TITLE_CLASS = 'text-base font-semibold text-default-900';
const CARD_DESC_CLASS = 'text-sm leading-6 text-default-600';
const SUBTITLE_CLASS = 'text-sm font-medium text-default-900';
const SUBDESC_CLASS = 'text-xs leading-5 text-default-500';
const MUTED_CLASS = 'text-xs leading-5 text-default-400';
const SOFT_PANEL_CLASS = 'rounded-medium bg-default-50 px-3 py-3 dark:bg-default-100/5';

interface DesktopUpdateState extends Omit<SystemUpdateStatus, 'currentDigest' | 'latestDigest'> {
  checking?: boolean;
  downloadUrl?: string | null;
  recentCommits?: Array<{
    id: string;
    shortId: string;
    title: string;
    publishedAt: string | null;
  }>;
  currentDigest?: string | null;
  latestDigest?: string | null;
  phase?: DesktopUpdateStatus['phase'];
  autoUpdateSupported?: boolean;
  autoUpdateTarget?: string | null;
  autoUpdateInstallerFamily?: string | null;
  autoUpdateReason?: string | null;
  downloadProgress?: DesktopUpdateStatus['downloadProgress'];
  downloaded?: boolean;
  pendingInstallIdentity?: string | null;
  lastInstallFailed?: boolean;
}

function formatDateTimeValue(value?: string | null): string {
  if (!value) return '-';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString();
}

function formatCommitValue(value?: string | null): string {
  const trimmed = (value || '').trim();
  return trimmed ? trimmed.slice(0, 7) : '-';
}

function formatVersionValue(value?: string | null): string {
  const trimmed = (value || '').trim();
  return trimmed || '-';
}

export function DesktopUpdateCard() {
  const { t } = useTranslation('common');
  const updateNotification = useUpdateNotification();
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateState | null>(null);
  const [desktopUpdateBusyAction, setDesktopUpdateBusyAction] = useState<'check' | 'download' | 'install' | 'openWebsite' | 'openCommits' | null>(null);
  const [desktopUpdateError, setDesktopUpdateError] = useState('');
  const [desktopUpdateExpanded, setDesktopUpdateExpanded] = useState(false);

  const loadDesktopUpdateStatus = useCallback(async () => {
    try {
      if (updateNotification.status) {
        setDesktopUpdateStatus(updateNotification.status as DesktopUpdateState);
        setDesktopUpdateError(updateNotification.status.errorMessage || '');
        setDesktopUpdateExpanded(false);
        return;
      }

      if (window.electronAPI?.updater?.getStatus) {
        const status = await window.electronAPI.updater.getStatus();
        setDesktopUpdateStatus(status as DesktopUpdateState);
        setDesktopUpdateError(status.errorMessage || '');
        setDesktopUpdateExpanded(false);
        return;
      }

      const status = await api.getSystemUpdateStatus();
      setDesktopUpdateStatus(status as DesktopUpdateState);
      setDesktopUpdateError(status.errorMessage || '');
      setDesktopUpdateExpanded(false);
    } catch (err) {
      logger.error('Failed to load update status:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateCheckFailed'));
    }
  }, [t, updateNotification.status]);

  useEffect(() => {
    void loadDesktopUpdateStatus();
  }, [loadDesktopUpdateStatus]);

  useEffect(() => {
    if (updateNotification.status) {
      setDesktopUpdateStatus(updateNotification.status as DesktopUpdateState);
      setDesktopUpdateError(updateNotification.status.errorMessage || '');
    }
  }, [updateNotification.status]);

  useEffect(() => {
    if (!window.electronAPI?.updater?.onStatus) return undefined;
    const handleStatus = (status: DesktopUpdateStatus) => {
      setDesktopUpdateStatus(status as DesktopUpdateState);
      setDesktopUpdateError(status.errorMessage || '');
    };
    window.electronAPI.updater.onStatus(handleStatus);
    return () => {
      window.electronAPI?.updater?.offStatus?.(handleStatus);
    };
  }, []);

  const handleCheckDesktopUpdate = useCallback(async () => {
    setDesktopUpdateBusyAction('check');
    setDesktopUpdateError('');
    try {
      let status: UpdateStatusWithDownloads | SystemUpdateStatus | DesktopUpdateStatus | null = null;
      if (updateNotification.refresh) {
        status = await updateNotification.refresh();
      }
      if (!status && window.electronAPI?.updater?.check) {
        status = await window.electronAPI.updater.check();
      }
      if (!status) {
        status = await api.getSystemUpdateStatus();
      }
      setDesktopUpdateStatus(status as DesktopUpdateState);
      setDesktopUpdateError(status.errorMessage || '');
      setDesktopUpdateExpanded(false);
    } catch (err) {
      logger.error('Failed to check update:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateCheckFailed'));
    } finally {
      setDesktopUpdateBusyAction(null);
    }
  }, [t, updateNotification]);

  const handleOpenUpdateWebsite = useCallback(async () => {
    const url = desktopUpdateStatus?.websiteUrl || 'https://tx5dr.com';
    setDesktopUpdateBusyAction('openWebsite');
    setDesktopUpdateError('');
    try {
      if (window.electronAPI?.shell?.openExternal) {
        await window.electronAPI.shell.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      logger.error('Failed to open update website:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateOpenFailed'));
    } finally {
      setDesktopUpdateBusyAction(null);
    }
  }, [desktopUpdateStatus?.websiteUrl, t]);

  const handleDownloadDesktopUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater?.download) {
      await handleOpenUpdateWebsite();
      return;
    }
    setDesktopUpdateBusyAction('download');
    setDesktopUpdateError('');
    try {
      const status = await window.electronAPI.updater.download();
      setDesktopUpdateStatus(status as DesktopUpdateState);
      setDesktopUpdateError(status.errorMessage || '');
    } catch (err) {
      logger.error('Failed to download desktop update:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateDownloadFailed'));
    } finally {
      setDesktopUpdateBusyAction(null);
    }
  }, [handleOpenUpdateWebsite, t]);

  const handleInstallDesktopUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater?.installAndRestart) return;
    setDesktopUpdateBusyAction('install');
    setDesktopUpdateError('');
    try {
      const status = await window.electronAPI.updater.installAndRestart();
      setDesktopUpdateStatus(status as DesktopUpdateState);
      setDesktopUpdateError(status.errorMessage || '');
    } catch (err) {
      logger.error('Failed to install desktop update:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateInstallFailed'));
      setDesktopUpdateBusyAction(null);
    }
  }, [t]);

  const handleOpenDesktopUpdateCommits = useCallback(async () => {
    setDesktopUpdateBusyAction('openCommits');
    setDesktopUpdateError('');
    try {
      if (window.electronAPI?.shell?.openExternal) {
        await window.electronAPI.shell.openExternal(DESKTOP_UPDATE_COMMITS_URL);
      } else {
        window.open(DESKTOP_UPDATE_COMMITS_URL, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      logger.error('Failed to open desktop update commits page:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateOpenFailed'));
    } finally {
      setDesktopUpdateBusyAction(null);
    }
  }, [t]);

  const desktopUpdatePhase = desktopUpdateStatus?.phase || (desktopUpdateStatus?.checking ? 'checking' : 'idle');
  const desktopUpdateBusy = desktopUpdateBusyAction !== null;
  const desktopUpdateProgress = desktopUpdateStatus?.downloadProgress;
  const desktopUpdateProgressLabel = desktopUpdateProgress
    ? `${Math.round(desktopUpdateProgress.percent)}%`
    : '';
  const canAutoDownloadDesktopUpdate = Boolean(
    isElectron
    && desktopUpdateStatus?.updateAvailable
    && desktopUpdateStatus?.autoUpdateSupported
    && desktopUpdatePhase !== 'downloaded'
    && desktopUpdatePhase !== 'installing',
  );
  const canInstallDownloadedDesktopUpdate = Boolean(isElectron && (desktopUpdateStatus?.downloaded || desktopUpdatePhase === 'downloaded'));
  const isElectronUpdateTarget = isElectron || desktopUpdateStatus?.target === 'electron-app';
  const updateTargetLabel = isElectronUpdateTarget
    ? t('system.updateTargetElectron', 'Electron')
    : desktopUpdateStatus?.target === 'docker'
      ? t('system.updateTargetDocker', 'Docker')
      : desktopUpdateStatus?.target === 'android-runtime'
        ? t('system.updateTargetAndroidRuntime', 'Android Runtime')
        : t('system.updateTargetLinuxServer', 'Linux Server');
  const desktopRecentCommits = desktopUpdateStatus?.recentCommits || [];

  return (
    <Card shadow="none">
      <CardBody className={`${CARD_BODY_CLASS} space-y-4`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className={CARD_TITLE_CLASS}>{t('system.updateTitle', 'Version Updates')}</h4>
            <p className={`mt-1 ${CARD_DESC_CLASS}`}>
              {isElectronUpdateTarget
                ? t('system.desktopUpdateDesc')
                : t('system.updateWebsiteOnlyDesc', 'Checks whether a newer build exists. This deployment is updated outside the web UI; use the official website for instructions.')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip size="sm" color="default" variant="flat">
              {updateTargetLabel}
            </Chip>
            <Chip size="sm" color="default" variant="flat">
              {desktopUpdateStatus?.channel === 'nightly'
                ? t('system.desktopUpdateChannelNightly')
                : t('system.desktopUpdateChannelRelease')}
            </Chip>
            <Chip size="sm" color={desktopUpdatePhase === 'error' ? 'danger' : desktopUpdatePhase === 'downloaded' ? 'success' : desktopUpdatePhase === 'unsupported' ? 'warning' : 'default'} variant="flat">
              {t(`system.desktopUpdatePhase.${desktopUpdatePhase}`)}
            </Chip>
          </div>
        </div>

        {desktopUpdateError && (
          <Alert color="danger" variant="flat" title={desktopUpdateError} />
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <div className={SOFT_PANEL_CLASS}>
            <p className={SUBTITLE_CLASS}>{t('system.desktopUpdateCurrentVersion')}</p>
            <p className={`mt-1 ${CARD_DESC_CLASS}`}>
              {formatVersionValue(desktopUpdateStatus?.currentVersion)}
            </p>
            <p className={`mt-2 ${MUTED_CLASS}`}>
              {t('system.desktopUpdateCurrentCommit', { value: formatCommitValue(desktopUpdateStatus?.currentCommit) })}
            </p>
            <p className={`mt-2 ${MUTED_CLASS}`}>
              {t('system.desktopUpdatePublishedAt', { value: formatDateTimeValue(desktopUpdateStatus?.currentPublishedAt) })}
            </p>
          </div>

          <div className={SOFT_PANEL_CLASS}>
            <p className={SUBTITLE_CLASS}>{t('system.desktopUpdateLatestVersion')}</p>
            <p className={`mt-1 ${CARD_DESC_CLASS}`}>
              {formatVersionValue(desktopUpdateStatus?.latestVersion)}
            </p>
            <p className={`mt-2 ${MUTED_CLASS}`}>
              {t('system.desktopUpdateLatestCommit', { value: formatCommitValue(desktopUpdateStatus?.latestCommit) })}
            </p>
            <p className={`mt-2 ${MUTED_CLASS}`}>
              {t('system.desktopUpdatePublishedAt', { value: formatDateTimeValue(desktopUpdateStatus?.publishedAt) })}
            </p>
          </div>
        </div>

        <div className={`${SOFT_PANEL_CLASS} space-y-2`}>
          <div className="flex flex-wrap items-center gap-2">
            <Chip
              size="sm"
              color={desktopUpdateStatus?.updateAvailable ? 'warning' : 'success'}
              variant="flat"
            >
              {desktopUpdateStatus?.updateAvailable
                ? t('system.desktopUpdateAvailable')
                : t('system.desktopUpdateUpToDate')}
            </Chip>
            {desktopUpdateStatus?.latestCommit && (
              <Chip size="sm" color="default" variant="flat">
                {t('system.desktopUpdateLatestCommit', { value: desktopUpdateStatus.latestCommit })}
              </Chip>
            )}
          </div>

          <div>
            <p className={SUBTITLE_CLASS}>{t('system.desktopUpdateLatestSummary')}</p>
            <p className={`mt-1 ${SUBDESC_CLASS}`}>
              {desktopUpdateStatus?.latestCommitTitle || t('system.desktopUpdateNoSummary')}
            </p>
          </div>

          {desktopRecentCommits.length > 0 && (
            <div className="rounded-medium border border-divider bg-content1 px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className={SUBTITLE_CLASS}>{t('system.desktopUpdateRecentCommitsTitle')}</p>
                  <p className={`mt-1 ${SUBDESC_CLASS}`}>{t('system.desktopUpdateRecentCommitsDesc')}</p>
                </div>
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => setDesktopUpdateExpanded((value) => !value)}
                >
                  {desktopUpdateExpanded
                    ? t('system.desktopUpdateRecentCommitsCollapse')
                    : t('system.desktopUpdateRecentCommitsExpand')}
                </Button>
              </div>

              {desktopUpdateExpanded && (
                <div className="mt-3 space-y-2">
                  {desktopRecentCommits.map((commit) => (
                    <div key={`${commit.id}-${commit.publishedAt || commit.shortId}`} className="rounded-medium border border-divider bg-default-50 px-3 py-3 dark:bg-default-100/5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className={SUBTITLE_CLASS}>
                          {commit.title || t('system.desktopUpdateNoSummary')}
                        </p>
                        <Chip size="sm" color="default" variant="flat">
                          {commit.shortId || commit.id || '-'}
                        </Chip>
                      </div>
                      <p className={`mt-2 ${SUBDESC_CLASS}`}>
                        {t('system.desktopUpdateRecentCommitTime', { value: formatDateTimeValue(commit.publishedAt) })}
                      </p>
                      <p className={`mt-1 break-all ${MUTED_CLASS}`}>
                        {t('system.desktopUpdateRecentCommitId', { value: commit.id || commit.shortId || '-' })}
                      </p>
                    </div>
                  ))}

                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => { void handleOpenDesktopUpdateCommits(); }}
                    isLoading={desktopUpdateBusyAction === 'openCommits'}
                    isDisabled={desktopUpdateBusy && desktopUpdateBusyAction !== 'openCommits'}
                  >
                    {t('system.desktopUpdateViewAllCommits')}
                  </Button>
                </div>
              )}
            </div>
          )}

          <p className={`${SUBDESC_CLASS} whitespace-pre-wrap`}>
            {desktopUpdateStatus?.releaseNotes || t('system.desktopUpdateNoNotes')}
          </p>

          {desktopUpdatePhase === 'downloading' && desktopUpdateProgress && (
            <div className="rounded-medium border border-divider bg-content1 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={SUBTITLE_CLASS}>{t('system.desktopUpdateDownloading')}</p>
                <Chip size="sm" color="primary" variant="flat">{desktopUpdateProgressLabel}</Chip>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-default-200">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, desktopUpdateProgress.percent))}%` }}
                />
              </div>
              <p className={`mt-2 ${MUTED_CLASS}`}>
                {t('system.desktopUpdateDownloadProgress', {
                  transferred: Math.round((desktopUpdateProgress.transferred || 0) / 1024 / 1024),
                  total: Math.round((desktopUpdateProgress.total || 0) / 1024 / 1024),
                })}
              </p>
            </div>
          )}

          {desktopUpdateStatus?.updateAvailable && !desktopUpdateStatus?.autoUpdateSupported && desktopUpdateStatus?.autoUpdateReason && (
            <Alert color="warning" variant="flat" title={t(`system.desktopUpdateAutoReason.${desktopUpdateStatus.autoUpdateReason}`, { defaultValue: t('system.desktopUpdateManualFallback') })} />
          )}
        </div>


        <div className="flex flex-wrap gap-3">
          <Button
            color="primary"
            variant="flat"
            onPress={() => { void handleCheckDesktopUpdate(); }}
            isLoading={desktopUpdateBusyAction === 'check' || (desktopUpdatePhase === 'checking' && desktopUpdateStatus?.checking)}
            isDisabled={desktopUpdateBusy}
          >
            {t('system.desktopUpdateCheck')}
          </Button>

          {isElectronUpdateTarget && canAutoDownloadDesktopUpdate && (
            <Button
              color="primary"
              onPress={() => { void handleDownloadDesktopUpdate(); }}
              isLoading={desktopUpdateBusyAction === 'download' || desktopUpdatePhase === 'downloading'}
              isDisabled={(desktopUpdateBusy && desktopUpdateBusyAction !== 'download') || desktopUpdatePhase === 'downloading'}
            >
              {desktopUpdatePhase === 'downloading' ? t('system.desktopUpdateDownloading') : t('system.desktopUpdateDownload')}
            </Button>
          )}

          {isElectronUpdateTarget && canInstallDownloadedDesktopUpdate && (
            <Button
              color="success"
              onPress={() => { void handleInstallDesktopUpdate(); }}
              isLoading={desktopUpdateBusyAction === 'install' || desktopUpdatePhase === 'installing'}
              isDisabled={(desktopUpdateBusy && desktopUpdateBusyAction !== 'install') || desktopUpdatePhase === 'installing'}
            >
              {t('system.desktopUpdateInstallAndRestart')}
            </Button>
          )}

          {isElectronUpdateTarget && !canAutoDownloadDesktopUpdate && !canInstallDownloadedDesktopUpdate && (
            <Button
              color="primary"
              onPress={() => { void handleOpenUpdateWebsite(); }}
              isLoading={desktopUpdateBusyAction === 'openWebsite'}
              isDisabled={desktopUpdateBusy && desktopUpdateBusyAction !== 'openWebsite'}
            >
              {t('system.updateOpenWebsite', 'Official website')}
            </Button>
          )}

          {!isElectronUpdateTarget && (
            <Button
              color="primary"
              onPress={() => { void handleOpenUpdateWebsite(); }}
              isLoading={desktopUpdateBusyAction === 'openWebsite'}
              isDisabled={desktopUpdateBusy && desktopUpdateBusyAction !== 'openWebsite'}
            >
              {t('system.updateOpenWebsite', 'Official website')}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
