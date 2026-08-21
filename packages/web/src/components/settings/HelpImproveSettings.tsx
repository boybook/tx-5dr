import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, CardBody, Input, Select, SelectItem, Switch, Textarea } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRotateRight, faChartSimple, faCheckCircle, faCloudArrowUp, faShieldHalved } from '@fortawesome/free-solid-svg-icons';
import { api, ApiError } from '@tx5dr/core';
import {
  OBSERVABILITY_NOTICE_VERSION,
  type DiagnosticLogSource,
  type DiagnosticLogSourceId,
  type DiagnosticUploadReceipt,
  type ObservabilityStatus,
} from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger';
import {
  canSubmitDiagnosticUpload,
  chooseDefaultDiagnosticSource,
  DEFAULT_DIAGNOSTIC_TIME_PRESET,
  diagnosticRangeOverlapsSource,
  resolveDiagnosticRange,
  type DiagnosticTimePreset,
} from './helpImprovePolicy';

const logger = createLogger('HelpImproveSettings');

type UploadState =
  | { kind: 'success'; receipt: DiagnosticUploadReceipt }
  | { kind: 'error'; message: string }
  | null;

export interface HelpImproveSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface HelpImproveSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

function toLocalInputValue(value: Date): string {
  const offset = value.getTimezoneOffset() * 60 * 1000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatRangeBoundary(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const HelpImproveSettings = forwardRef<HelpImproveSettingsRef, HelpImproveSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const { t } = useTranslation(['settings', 'common']);
    const [observabilityStatus, setObservabilityStatus] = useState<ObservabilityStatus | null>(null);
    const [observabilityEnabled, setObservabilityEnabled] = useState(true);
    const [originalObservabilityEnabled, setOriginalObservabilityEnabled] = useState(true);
    const [observabilityError, setObservabilityError] = useState(false);
    const [sources, setSources] = useState<DiagnosticLogSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(true);
    const [sourcesError, setSourcesError] = useState(false);
    const [sourceId, setSourceId] = useState<DiagnosticLogSourceId | null>(null);
    const [timePreset, setTimePreset] = useState<DiagnosticTimePreset>(DEFAULT_DIAGNOSTIC_TIME_PRESET);
    const [customFrom, setCustomFrom] = useState(() => toLocalInputValue(new Date(Date.now() - 60 * 60 * 1000)));
    const [customTo, setCustomTo] = useState(() => toLocalInputValue(new Date()));
    const [feedback, setFeedback] = useState('');
    const [uploading, setUploading] = useState(false);
    const [uploadState, setUploadState] = useState<UploadState>(null);

    useEffect(() => {
      let active = true;
      void Promise.allSettled([api.getObservabilityStatus(), api.getDiagnosticLogSources()]).then((results) => {
        if (!active) return;
        const [observabilityResult, sourcesResult] = results;
        if (observabilityResult.status === 'fulfilled') {
          const status = observabilityResult.value;
          setObservabilityStatus(status);
          setObservabilityEnabled(status.settings.enabled);
          setOriginalObservabilityEnabled(status.settings.enabled);
          setObservabilityError(false);
        } else {
          logger.error('Failed to load anonymous runtime settings', observabilityResult.reason);
          setObservabilityError(true);
        }
        if (sourcesResult.status === 'fulfilled') {
          const availableSources = sourcesResult.value.sources;
          setSources(availableSources);
          setSourceId(chooseDefaultDiagnosticSource(availableSources));
          setSourcesError(false);
        } else {
          logger.error('Failed to load diagnostic log sources', sourcesResult.reason);
          setSourcesError(true);
        }
        setSourcesLoading(false);
      });
      return () => { active = false; };
    }, []);

    const retrySources = useCallback(async () => {
      setSourcesLoading(true);
      setSourcesError(false);
      setUploadState(null);
      try {
        const result = await api.getDiagnosticLogSources();
        setSources(result.sources);
        setSourceId(chooseDefaultDiagnosticSource(result.sources));
      } catch (error) {
        logger.error('Failed to reload diagnostic log sources', error);
        setSourcesError(true);
      } finally {
        setSourcesLoading(false);
      }
    }, []);

    const hasUnsavedChanges = useCallback(
      () => observabilityEnabled !== originalObservabilityEnabled,
      [observabilityEnabled, originalObservabilityEnabled],
    );

    const save = useCallback(async () => {
      if (!hasUnsavedChanges()) return;
      const status = await api.updateObservabilitySettings({
        enabled: observabilityEnabled,
        noticeVersion: OBSERVABILITY_NOTICE_VERSION,
      });
      setObservabilityStatus(status);
      setObservabilityEnabled(status.settings.enabled);
      setOriginalObservabilityEnabled(status.settings.enabled);
      onUnsavedChanges?.(false);
    }, [hasUnsavedChanges, observabilityEnabled, onUnsavedChanges]);

    useImperativeHandle(ref, () => ({ hasUnsavedChanges, save }), [hasUnsavedChanges, save]);

    useEffect(() => {
      onUnsavedChanges?.(hasUnsavedChanges());
    }, [hasUnsavedChanges, onUnsavedChanges]);

    const selectedSource = useMemo(
      () => sources.find((source) => source.id === sourceId) ?? null,
      [sourceId, sources],
    );

    const sourceLabel = useCallback((id: DiagnosticLogSourceId) => (
      t(`helpImprove.sources.${id}`)
    ), [t]);

    const sourceDescription = useCallback((id: DiagnosticLogSourceId) => (
      t(`helpImprove.sourceDescriptions.${id}`)
    ), [t]);

    const presetLabel = useCallback((preset: DiagnosticTimePreset) => (
      t(`helpImprove.time.${preset}`)
    ), [t]);

    const resolveRange = useCallback((): { fromMs: number; toMs: number } | null => {
      return resolveDiagnosticRange(timePreset, Date.now(), customFrom, customTo);
    }, [customFrom, customTo, timePreset]);

    const selectedRange = useMemo(
      () => resolveDiagnosticRange(timePreset, Date.now(), customFrom, customTo),
      [customFrom, customTo, timePreset],
    );
    const rangeOverlapsAvailableLogs = useMemo(
      () => diagnosticRangeOverlapsSource(selectedRange, selectedSource),
      [selectedRange, selectedSource],
    );

    const handleUpload = useCallback(async () => {
      const range = resolveRange();
      if (!sourceId || !range) {
        setUploadState({ kind: 'error', message: t('helpImprove.status.invalidRange') });
        return;
      }
      setUploading(true);
      setUploadState(null);
      try {
        const receipt = await api.uploadDiagnosticLogs({
          sourceId,
          fromMs: range.fromMs,
          toMs: range.toMs,
          ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
        });
        setUploadState({ kind: 'success', receipt });
      } catch (error) {
        logger.error('Diagnostic upload failed', error);
        const translated = error instanceof ApiError && error.userMessageKey
          ? t(error.userMessageKey, error.userMessageParams)
          : error instanceof ApiError
            ? error.userMessage
            : t('helpImprove.status.networkFailed');
        setUploadState({ kind: 'error', message: translated });
      } finally {
        setUploading(false);
      }
    }, [feedback, resolveRange, sourceId, t]);

    const coverageText = selectedSource?.availableFromMs != null && selectedSource.availableToMs != null
      ? t('helpImprove.coverageValue', {
          from: new Date(selectedSource.availableFromMs).toLocaleString(),
          to: new Date(selectedSource.availableToMs).toLocaleString(),
          files: selectedSource.fileCount,
          size: formatBytes(selectedSource.totalBytes),
        })
      : t('helpImprove.coverageUnknown');

    const selectionText = selectedRange && sourceId
      ? timePreset === 'custom'
        ? t('helpImprove.selectionSummary', {
            source: sourceLabel(sourceId),
            from: formatRangeBoundary(selectedRange.fromMs),
            to: formatRangeBoundary(selectedRange.toMs),
          })
        : t('helpImprove.selectionPresetSummary', {
            source: sourceLabel(sourceId),
            range: presetLabel(timePreset),
          })
      : t('helpImprove.selectionUnavailable');

    return (
      <div className="flex flex-col gap-6">
        <div>
          <h3 className="text-xl font-bold text-default-900 mb-2">{t('helpImprove.title')}</h3>
          <p className="text-default-600">{t('helpImprove.description')}</p>
        </div>

        <Card shadow="none" radius="lg" className="border border-divider bg-content1">
          <CardBody className="p-5 space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 max-w-3xl">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faChartSimple} className="text-primary" />
                  <h4 className="text-base font-semibold text-default-900">{t('helpImprove.telemetryTitle')}</h4>
                </div>
                <p className="mt-1 text-sm leading-6 text-default-600">
                  {t('helpImprove.telemetryDescription')}
                </p>
              </div>
              <Switch
                isSelected={observabilityEnabled}
                onValueChange={setObservabilityEnabled}
                isDisabled={!observabilityStatus}
                className="shrink-0"
              >
                {observabilityEnabled
                  ? t('common:system.anonymousTelemetryEnabled')
                  : t('common:system.anonymousTelemetryDisabled')}
              </Switch>
            </div>
            {observabilityStatus?.noticeRequired && (
              <Alert color="warning" variant="flat">
                {t('common:system.anonymousTelemetryConsent')}
              </Alert>
            )}
            {observabilityError && (
              <Alert color="danger" variant="flat">{t('common:system.loadFailed')}</Alert>
            )}
            <div className="grid gap-3 rounded-medium bg-default-50 px-3 py-3 text-sm leading-6 text-default-600 dark:bg-default-100/5 lg:grid-cols-2">
              <div>
                <p className="font-medium text-default-800">{t('common:system.anonymousTelemetryCollectedTitle')}</p>
                <p className="mt-0.5">{t('common:system.anonymousTelemetryCollected')}</p>
              </div>
              <div>
                <p className="font-medium text-default-800">{t('common:system.anonymousTelemetryNeverCollectedTitle')}</p>
                <p className="mt-0.5">{t('common:system.anonymousTelemetryNeverCollected')}</p>
              </div>
            </div>
            {observabilityStatus && !observabilityStatus.endpointConfigured && (
              <p className="text-xs leading-5 text-default-400">{t('common:system.anonymousTelemetryUnavailable')}</p>
            )}
          </CardBody>
        </Card>

        <Card shadow="none" radius="lg" className="border border-divider bg-content1">
          <CardBody className="p-5 space-y-5">
            <div>
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faCloudArrowUp} className="text-primary" />
                <h4 className="text-base font-semibold text-default-900">{t('helpImprove.uploadTitle')}</h4>
              </div>
              <p className="mt-1 text-sm leading-6 text-default-600">{t('helpImprove.uploadDescription')}</p>
            </div>

            <Alert color="warning" variant="flat" icon={<FontAwesomeIcon icon={faShieldHalved} />}>
              {t('helpImprove.privacyNotice')}
            </Alert>

            {sourcesError && (
              <Alert color="danger" variant="flat">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t('helpImprove.status.sourcesUnavailable')}</span>
                  <Button
                    size="sm"
                    color="danger"
                    variant="flat"
                    startContent={<FontAwesomeIcon icon={faArrowRotateRight} />}
                    onPress={() => void retrySources()}
                  >
                    {t('helpImprove.retry')}
                  </Button>
                </div>
              </Alert>
            )}
            {!sourcesLoading && !sourcesError && sources.length === 0 && (
              <Alert color="warning" variant="flat">{t('helpImprove.status.noSources')}</Alert>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <Select
                label={t('helpImprove.logSource')}
                selectedKeys={sourceId ? new Set([sourceId]) : new Set()}
                onSelectionChange={(keys) => {
                  const next = Array.from(keys)[0];
                  setSourceId(typeof next === 'string' ? next as DiagnosticLogSourceId : null);
                  setUploadState(null);
                }}
                isDisabled={sourcesLoading || sources.length === 0 || uploading}
                isLoading={sourcesLoading}
                description={sourceId ? sourceDescription(sourceId) : undefined}
              >
                {sources.map((source) => (
                  <SelectItem key={source.id} textValue={sourceLabel(source.id)}>
                    <div className="flex flex-col">
                      <span>{sourceLabel(source.id)}</span>
                      <span className="text-xs text-default-400">{source.fileName}</span>
                    </div>
                  </SelectItem>
                ))}
              </Select>

              <Select
                label={t('helpImprove.timeRange')}
                selectedKeys={new Set([timePreset])}
                onSelectionChange={(keys) => {
                  const next = Array.from(keys)[0];
                  if (typeof next === 'string') setTimePreset(next as DiagnosticTimePreset);
                  setUploadState(null);
                }}
                isDisabled={uploading}
              >
                {(['15m', '1h', '6h', '24h', 'custom'] as DiagnosticTimePreset[]).map((preset) => (
                  <SelectItem key={preset}>{presetLabel(preset)}</SelectItem>
                ))}
              </Select>
            </div>

            {timePreset === 'custom' && (
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  type="datetime-local"
                  label={t('helpImprove.customFrom')}
                  value={customFrom}
                  onValueChange={(value) => { setCustomFrom(value); setUploadState(null); }}
                  isDisabled={uploading}
                  isInvalid={!selectedRange}
                />
                <Input
                  type="datetime-local"
                  label={t('helpImprove.customTo')}
                  value={customTo}
                  onValueChange={(value) => { setCustomTo(value); setUploadState(null); }}
                  isDisabled={uploading}
                  isInvalid={!selectedRange}
                />
              </div>
            )}

            {timePreset === 'custom' && !selectedRange && (
              <p className="text-sm text-danger">{t('helpImprove.status.invalidRange')}</p>
            )}

            <div className="rounded-medium bg-default-50 px-3 py-3 dark:bg-default-100/5">
              <p className="text-sm font-medium text-default-900">{t('helpImprove.selectionTitle')}</p>
              <p className="mt-1 text-sm leading-5 text-default-700">{selectionText}</p>
              <p className="mt-2 text-xs leading-5 text-default-500">
                <span className="font-medium text-default-600">{t('helpImprove.coverageTitle')}: </span>
                {coverageText}
              </p>
              {selectedRange && !rangeOverlapsAvailableLogs && (
                <p className="mt-2 text-xs leading-5 text-warning-700 dark:text-warning-400">
                  {t('helpImprove.selectionOutsideCoverage')}
                </p>
              )}
            </div>

            <Textarea
              label={t('helpImprove.feedbackLabel')}
              placeholder={t('helpImprove.feedbackPlaceholder')}
              value={feedback}
              onValueChange={(value) => { setFeedback(value); setUploadState(null); }}
              maxLength={2000}
              minRows={3}
              isDisabled={uploading}
              description={t('helpImprove.feedbackCount', { count: feedback.length })}
            />

            {uploadState?.kind === 'error' && (
              <Alert color="danger" variant="flat">{uploadState.message}</Alert>
            )}
            {uploadState?.kind === 'success' && (
              <Alert color="success" variant="flat" icon={<FontAwesomeIcon icon={faCheckCircle} />}>
                <div>
                  <p className="font-medium">{t('helpImprove.status.success')}</p>
                  <p className="mt-1 text-xs">
                    {t('helpImprove.status.receipt', {
                      id: uploadState.receipt.uploadId.slice(0, 8),
                      lines: uploadState.receipt.lineCount,
                      until: new Date(uploadState.receipt.retainedUntil).toLocaleString(),
                    })}
                  </p>
                </div>
              </Alert>
            )}

            <div className="flex justify-end">
              <Button
                color="primary"
                startContent={!uploading ? <FontAwesomeIcon icon={faCloudArrowUp} /> : undefined}
                isLoading={uploading}
                isDisabled={!canSubmitDiagnosticUpload({
                  sourceId,
                  sourcesLoading,
                  uploading,
                  sourceCount: sources.length,
                  rangeIsValid: selectedRange !== null,
                  rangeOverlapsAvailableLogs,
                })}
                onPress={() => void handleUpload()}
              >
                {uploading ? t('helpImprove.uploading') : t('helpImprove.uploadButton')}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  },
);

HelpImproveSettings.displayName = 'HelpImproveSettings';
