import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Switch, Tooltip } from '@heroui/react';
import type { ClockStatusDetail, ClockStatusSummary } from '@tx5dr/contracts';
import { UserRole } from '@tx5dr/contracts';
import { ApiError, api } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import { useConnection, useRadioState } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { getApiBaseUrl } from '../../utils/config';

const formatUTCTime = (date: Date) => date.toISOString().slice(11, 19);

function formatOffset(ms: number): string {
  return `${ms > 0 ? '+' : ''}${ms.toFixed(1)}`;
}

function getIndicatorDotColor(status: ClockStatusSummary | null): string {
  switch (status?.indicatorState) {
    case 'ok':
      return 'bg-success';
    case 'warn':
    case 'stale':
      return 'bg-warning';
    case 'alert':
      return 'bg-danger';
    default:
      return 'bg-default-300';
  }
}

function getIndicatorTooltip(
  t: (key: string, options?: Record<string, unknown>) => string,
  status: ClockStatusSummary | null,
): string {
  if (!status) {
    return t('clock.never');
  }

  const parts: string[] = [];
  switch (status.indicatorState) {
    case 'ok':
      parts.push(t('clock.synced'));
      break;
    case 'warn':
      parts.push(t('clock.warn'));
      break;
    case 'alert':
      parts.push(t('clock.alert'));
      break;
    case 'stale':
      parts.push(t('clock.stale'));
      break;
    case 'failed':
      parts.push(t('clock.failed'));
      break;
    case 'never':
    default:
      parts.push(t('clock.never'));
      break;
  }

  if (status.appliedOffsetMs !== 0) {
    parts.push(`${t('clock.appliedOffset')}: ${formatOffset(status.appliedOffsetMs)}ms`);
  }

  return parts.join(' | ');
}

type FeedbackState = { type: 'success' | 'error'; message: string } | null;

function getFeedbackMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.userMessage;
  }
  return error instanceof Error ? error.message : fallback;
}

export const ClockDisplay: React.FC = () => {
  const { t } = useTranslation('common');
  const { state: radioState } = useRadioState();
  const { state: connectionState } = useConnection();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isOpen, setIsOpen] = useState(false);
  const [detail, setDetail] = useState<ClockStatusDetail | null>(null);
  const [manualOffset, setManualOffset] = useState('0');
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [isUpdatingAutoApply, setIsUpdatingAutoApply] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>();

  const summary = radioState.clockStatus;
  const appliedOffset = summary?.appliedOffsetMs ?? 0;

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date(Date.now() + appliedOffset));
    }, 200);
    return () => clearInterval(timer);
  }, [appliedOffset]);

  useEffect(() => {
    return () => {
      clearTimeout(feedbackTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setFeedback(null);
      setDetail(null);
      return;
    }

    setManualOffset(appliedOffset.toString());
  }, [appliedOffset, isOpen]);

  const showFeedback = useCallback((type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 3000);
  }, []);

  const loadDetail = useCallback(async () => {
    setIsLoadingDetail(true);
    try {
      const nextDetail = await api.getClockStatus(getApiBaseUrl());
      setDetail(nextDetail);
      setManualOffset(nextDetail.appliedOffsetMs.toString());
    } catch (error) {
      showFeedback('error', getFeedbackMessage(error, t('clock.loadFailed')));
    } finally {
      setIsLoadingDetail(false);
    }
  }, [showFeedback, t]);

  useEffect(() => {
    if (!isAdmin || !isOpen || !connectionState.isConnected) {
      return;
    }

    void loadDetail();
  }, [connectionState.isConnected, isAdmin, isOpen, loadDetail]);

  const submitOffset = useCallback(async (offsetMs: number) => {
    setIsSaving(true);
    try {
      const nextDetail = await api.setClockOffset({ offsetMs }, getApiBaseUrl());
      setDetail(nextDetail);
      setManualOffset(nextDetail.appliedOffsetMs.toString());
      showFeedback('success', t('clock.applySuccess', { offset: formatOffset(nextDetail.appliedOffsetMs) }));
    } catch (error) {
      showFeedback('error', getFeedbackMessage(error, t('clock.saveFailed')));
    } finally {
      setIsSaving(false);
    }
  }, [showFeedback, t]);

  const handleSetManual = useCallback(async () => {
    const value = parseFloat(manualOffset);
    if (!Number.isFinite(value)) {
      showFeedback('error', t('clock.invalidOffset'));
      return;
    }
    await submitOffset(value);
  }, [manualOffset, showFeedback, submitOffset, t]);

  const handleMeasure = useCallback(async () => {
    setIsMeasuring(true);
    try {
      const nextDetail = await api.measureClockOffset(getApiBaseUrl());
      setDetail(nextDetail);
    } catch (error) {
      showFeedback('error', getFeedbackMessage(error, t('clock.measureFailed')));
    } finally {
      setIsMeasuring(false);
    }
  }, [showFeedback, t]);

  const handleApplyMeasured = useCallback(async () => {
    if (!detail || (detail.syncState !== 'synced' && detail.syncState !== 'stale')) {
      return;
    }
    await submitOffset(detail.measuredOffsetMs);
  }, [detail, submitOffset]);

  const handleAutoApplyChange = useCallback(async (enabled: boolean) => {
    const previousDetail = detail;
    if (previousDetail) {
      setDetail({ ...previousDetail, autoApplyOffset: enabled });
    }

    setIsUpdatingAutoApply(true);
    try {
      const nextDetail = await api.setClockAutoApply({ enabled }, getApiBaseUrl());
      setDetail(nextDetail);
      setManualOffset(nextDetail.appliedOffsetMs.toString());
      showFeedback('success', enabled ? t('clock.autoApplyEnabled') : t('clock.autoApplyDisabled'));
    } catch (error) {
      if (previousDetail) {
        setDetail(previousDetail);
      }
      showFeedback('error', getFeedbackMessage(error, t('clock.autoApplySaveFailed')));
    } finally {
      setIsUpdatingAutoApply(false);
    }
  }, [detail, showFeedback, t]);

  const tooltipContent = useMemo(() => getIndicatorTooltip(t, summary), [summary, t]);
  const syncDotColor = useMemo(() => getIndicatorDotColor(summary), [summary]);

  if (!isAdmin) {
    return (
      <div className="bg-content1 dark:bg-content2 rounded-md px-3 py-1 cursor-default">
        <div className="text-xs font-mono text-default-500">
          UTC {formatUTCTime(currentTime)}
        </div>
      </div>
    );
  }

  const clockElement = (
    <div className="bg-content1 dark:bg-content2 rounded-md px-3 py-1 flex items-center gap-1.5 cursor-pointer">
      <div className="text-xs font-mono text-default-500">
        UTC {formatUTCTime(currentTime)}
      </div>
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${syncDotColor}`} />
    </div>
  );

  const measuredOffsetLabel = detail && (detail.syncState === 'synced' || detail.syncState === 'stale')
    ? `${formatOffset(detail.measuredOffsetMs)}ms`
    : t('clock.never');
  const lastSyncLabel = detail?.lastSyncTime
    ? new Date(detail.lastSyncTime).toLocaleString()
    : null;
  const autoApplyEnabled = detail?.autoApplyOffset ?? false;

  return (
    <Popover isOpen={isOpen} onOpenChange={setIsOpen} placement="bottom-end">
      <Tooltip content={tooltipContent} placement="bottom" isDisabled={isOpen}>
        <div>
          <PopoverTrigger>{clockElement}</PopoverTrigger>
        </div>
      </Tooltip>
      <PopoverContent className="w-80 p-3">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">{t('clock.title')}</div>

          {feedback && (
            <div className={`text-xs px-2 py-1.5 rounded-md ${
              feedback.type === 'success'
                ? 'bg-success-50 text-success-700 dark:bg-success-100/10 dark:text-success-400'
                : 'bg-danger-50 text-danger-700 dark:bg-danger-100/10 dark:text-danger-400'
            }`}>
              {feedback.message}
            </div>
          )}

          <div className="flex flex-col gap-1 text-xs text-default-500">
            {!connectionState.isConnected && (
              <div className="text-warning-600 dark:text-warning-400">{t('clock.unavailable')}</div>
            )}
            <div className="flex justify-between gap-2">
              <span>{t('clock.measuredOffset')}</span>
              <span className="font-mono">{measuredOffsetLabel}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{t('clock.appliedOffset')}</span>
              <span className="font-mono">{formatOffset(appliedOffset)}ms</span>
            </div>
            {lastSyncLabel && (
              <div className="flex justify-between gap-2">
                <span>{t('clock.lastSync')}</span>
                <span className="text-right">{lastSyncLabel}</span>
              </div>
            )}
            {detail?.errorMessage && (
              <div className="text-danger-500">{t('clock.error', { message: detail.errorMessage })}</div>
            )}
          </div>

          <div className="rounded-lg border border-divider px-3 py-2">
            <Switch
              size="sm"
              isSelected={autoApplyEnabled}
              onValueChange={handleAutoApplyChange}
              isDisabled={isLoadingDetail || isSaving || isMeasuring || isUpdatingAutoApply || !connectionState.isConnected}
            >
              <span className="text-xs font-medium">{t('clock.autoApplyNtp')}</span>
            </Switch>
          </div>

          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="flat"
              onPress={handleMeasure}
              isLoading={isMeasuring}
              isDisabled={!connectionState.isConnected || isLoadingDetail || isSaving}
              className="flex-1"
            >
              {t('clock.measure')}
            </Button>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              onPress={handleApplyMeasured}
              isDisabled={
                isLoadingDetail
                || isSaving
                || isMeasuring
                || !detail
                || (detail.syncState !== 'synced' && detail.syncState !== 'stale')
              }
              className="flex-1"
            >
              {t('clock.applyNtp')}
            </Button>
          </div>

          <div className="flex gap-1.5 items-end">
            <Input
              size="sm"
              type="number"
              label={t('clock.manualOffset')}
              value={manualOffset}
              onValueChange={setManualOffset}
              endContent={<span className="text-xs text-default-400">ms</span>}
              classNames={{ input: 'text-right font-mono' }}
              isDisabled={isLoadingDetail || isSaving || isMeasuring || !connectionState.isConnected}
            />
            <Button
              size="sm"
              variant="flat"
              onPress={handleSetManual}
              isDisabled={isLoadingDetail || isSaving || isMeasuring || !connectionState.isConnected}
              className="flex-shrink-0"
            >
              {t('clock.apply')}
            </Button>
          </div>

          {isLoadingDetail && (
            <div className="text-xs text-default-400">{t('clock.loading')}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
