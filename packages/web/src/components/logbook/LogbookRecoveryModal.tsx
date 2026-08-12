import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Progress,
} from '@heroui/react';
import type { LogbookBackupStatus, LogbookRestorePreflight } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { canConfirmLogbookRestore } from './logbookRecoveryPolicy';
import { isLogbookRecoveryOperationBusy } from './logbookViewPolicy';

function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

interface LogbookRecoveryModalProps {
  isOpen: boolean;
  logBookId: string;
  status: LogbookBackupStatus | null;
  preflight: LogbookRestorePreflight | null;
  actionError?: string | null;
  localBusy?: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onCreateBackup: () => Promise<void>;
  onDownloadLatest: () => Promise<Blob>;
  onDownloadPreRestore: () => Promise<Blob>;
  onPrepareRestore: () => Promise<void>;
  onRestore: (preflightToken: string, expectedRevision: string) => Promise<void>;
  onRetryUnsaved: (attemptId: string) => Promise<void>;
  onDiscardUnsaved: (attemptId: string) => Promise<void>;
}

const LogbookRecoveryModal: React.FC<LogbookRecoveryModalProps> = ({
  isOpen,
  logBookId,
  status,
  preflight,
  actionError,
  localBusy = false,
  onClose,
  onRefresh,
  onCreateBackup,
  onDownloadLatest,
  onDownloadPreRestore,
  onPrepareRestore,
  onRestore,
  onRetryUnsaved,
  onDiscardUnsaved,
}) => {
  const { t } = useTranslation('logbook');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const operationBusy = isLogbookRecoveryOperationBusy(status);
  const busy = localBusy || operationBusy || pendingAction !== null;
  const unsaved = status?.unsaved ?? [];
  const capabilities = status?.capabilities;
  const canRestore = canConfirmLogbookRestore(
    logBookId,
    confirmation,
    riskAccepted,
    Boolean(preflight),
  );

  useEffect(() => {
    if (!isOpen) {
      setRiskAccepted(false);
      setConfirmation('');
      setPendingAction(null);
    }
  }, [isOpen]);

  const progress = useMemo(() => {
    const total = status?.operation?.totalBytes;
    const processed = status?.operation?.processedBytes;
    if (!total || processed === undefined) return undefined;
    return Math.min(100, Math.max(0, (processed / total) * 100));
  }, [status?.operation?.processedBytes, status?.operation?.totalBytes]);

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setPendingAction(key);
    try {
      await action();
    } catch {
      // The parent records a persistent, user-visible action error.
    } finally {
      setPendingAction(null);
    }
  };

  const download = async (kind: 'latest' | 'pre-restore'): Promise<void> => {
    await run(`download-${kind}`, async () => {
      const blob = kind === 'latest'
        ? await onDownloadLatest()
        : await onDownloadPreRestore();
      downloadBlob(blob, `${logBookId}-${kind === 'latest' ? 'backup' : 'pre-restore'}.adi`);
    });
  };

  const discard = async (attemptId: string): Promise<void> => {
    if (!window.confirm(t('recovery.unsaved.discardConfirm'))) return;
    await run(`discard-${attemptId}`, () => onDiscardUnsaved(attemptId));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { if (!busy) onClose(); }}
      isDismissable={!busy}
      hideCloseButton={busy}
      size="4xl"
      placement="center"
      scrollBehavior="inside"
      classNames={{
        base: 'm-0 h-[100dvh] max-h-[100dvh] rounded-none sm:m-4 sm:h-auto sm:max-h-[90dvh] sm:rounded-large',
        body: 'min-h-0',
      }}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-default-200">
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('recovery.title')}</span>
            <Chip size="sm" variant="flat" color={status?.mainHealth.writable ? 'success' : 'danger'}>
              {status ? t(`health.state.${status.mainHealth.state}`) : t('recovery.loading')}
            </Chip>
          </div>
          <span className="font-mono text-xs font-normal text-default-500">{logBookId}</span>
        </ModalHeader>

        <ModalBody className="gap-4 py-4">
          {actionError && (
            <Alert color="danger" variant="flat" title={t('recovery.actionFailed')} description={actionError} />
          )}

          {status?.operation && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{t(`recovery.operation.kind.${status.operation.kind}`)}</p>
                  <p className="text-xs text-default-500">{t('recovery.operation.phase', { phase: status.operation.phase })}</p>
                </div>
                <Chip
                  size="sm"
                  color={status.operation.state === 'failed' ? 'danger' : status.operation.state === 'succeeded' ? 'success' : 'primary'}
                  variant="flat"
                >
                  {t(`recovery.operation.state.${status.operation.state}`)}
                </Chip>
              </div>
              {progress !== undefined && (
                <Progress
                  className="mt-3"
                  aria-label={t('recovery.operation.progress')}
                  value={progress}
                  showValueLabel
                  size="sm"
                />
              )}
            </div>
          )}

          {unsaved.length > 0 && (
            <section className="rounded-xl border border-danger/30 bg-danger/5 p-4">
              <h3 className="font-semibold text-danger">{t('recovery.unsaved.title', { count: unsaved.length })}</h3>
              <p className="mt-1 text-sm text-default-600">{t('recovery.unsaved.description')}</p>
              <div className="mt-3 space-y-2">
                {unsaved.map((attempt) => (
                  <div key={attempt.attemptId} className="flex flex-col gap-3 rounded-lg bg-content1 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-mono text-sm font-semibold">{attempt.callsign}</p>
                      <p className="text-xs text-default-500">
                        {attempt.mode} · {formatDate(attempt.createdAt)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        color="primary"
                        isLoading={pendingAction === `retry-${attempt.attemptId}`}
                        isDisabled={busy || !status.mainHealth.writable}
                        onPress={() => { void run(`retry-${attempt.attemptId}`, () => onRetryUnsaved(attempt.attemptId)); }}
                      >
                        {t('recovery.unsaved.retry')}
                      </Button>
                      <Button
                        size="sm"
                        color="danger"
                        variant="light"
                        isLoading={pendingAction === `discard-${attempt.attemptId}`}
                        isDisabled={busy}
                        onPress={() => { void discard(attempt.attemptId); }}
                      >
                        {t('recovery.unsaved.discard')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-default-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{t('recovery.current.title')}</h3>
                  <p className="mt-1 text-xs text-default-500">{t('recovery.revision', { revision: status?.revision ?? '-' })}</p>
                </div>
                {status?.dirty && <Chip size="sm" color="warning" variant="flat">{t('recovery.current.dirty')}</Chip>}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-default-500">{t('recovery.current.pending')}</dt><dd className="font-medium">{status?.pendingMutations ?? '-'}</dd></div>
                <div><dt className="text-default-500">{t('recovery.current.state')}</dt><dd className="font-medium">{status ? t(`health.state.${status.mainHealth.state}`) : '-'}</dd></div>
              </dl>
            </section>

            <section className="rounded-xl border border-default-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{t('recovery.backup.title')}</h3>
                  <p className="mt-1 text-xs text-default-500">{t('recovery.backup.description')}</p>
                </div>
                <Chip size="sm" color={status?.latest ? 'success' : 'default'} variant="flat">
                  {status?.latest ? t('recovery.backup.available') : t('recovery.backup.missing')}
                </Chip>
              </div>
              {status?.latest && (
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-default-500">{t('recovery.backup.createdAt')}</dt><dd className="font-medium">{formatDate(status.latest.createdAt)}</dd></div>
                  <div><dt className="text-default-500">{t('recovery.backup.size')}</dt><dd className="font-medium">{formatBytes(status.latest.size)}</dd></div>
                  <div><dt className="text-default-500">{t('recovery.backup.records')}</dt><dd className="font-medium">{status.latest.recordCount ?? '-'}</dd></div>
                  <div><dt className="text-default-500">{t('recovery.backup.opaque')}</dt><dd className="font-medium">{status.latest.opaqueRecordCount ?? '-'}</dd></div>
                </dl>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {capabilities?.canCreate && (
                  <Button size="sm" color="primary" variant="flat" isDisabled={busy} isLoading={pendingAction === 'create'} onPress={() => { void run('create', onCreateBackup); }}>
                    {t('recovery.backup.create')}
                  </Button>
                )}
                {capabilities?.canDownload && (
                  <Button size="sm" variant="flat" isDisabled={busy} isLoading={pendingAction === 'download-latest'} onPress={() => { void download('latest'); }}>
                    {t('recovery.backup.download')}
                  </Button>
                )}
                {capabilities?.canDownloadPreRestore && (
                  <Button size="sm" variant="flat" isDisabled={busy} isLoading={pendingAction === 'download-pre-restore'} onPress={() => { void download('pre-restore'); }}>
                    {t('recovery.preRestore.download')}
                  </Button>
                )}
              </div>
            </section>
          </div>

          {capabilities?.canRestore && (
            <section className="rounded-xl border border-warning/30 bg-warning/5 p-4">
              <h3 className="font-semibold text-warning-700 dark:text-warning">{t('recovery.restore.title')}</h3>
              <p className="mt-1 text-sm text-default-600">{t('recovery.restore.description')}</p>

              {!preflight ? (
                <Button
                  className="mt-4"
                  color="warning"
                  variant="flat"
                  isDisabled={busy || !status}
                  isLoading={pendingAction === 'prepare'}
                  onPress={() => { void run('prepare', onPrepareRestore); }}
                >
                  {t('recovery.restore.compare')}
                </Button>
              ) : (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg bg-content1 p-3">
                      <p className="text-xs font-medium text-default-500">{t('recovery.restore.currentFile')}</p>
                      <p className="mt-1 text-sm">{t('recovery.restore.fileSummary', { records: preflight.main.recordCount, size: formatBytes(preflight.main.size) })}</p>
                    </div>
                    <div className="rounded-lg bg-content1 p-3">
                      <p className="text-xs font-medium text-default-500">{t('recovery.restore.backupFile')}</p>
                      <p className="mt-1 text-sm">{t('recovery.restore.fileSummary', { records: preflight.backup.recordCount, size: formatBytes(preflight.backup.size) })}</p>
                    </div>
                  </div>

                  <Alert
                    color={preflight.highRisk ? 'danger' : 'warning'}
                    variant="flat"
                    title={preflight.highRisk ? t('recovery.restore.highRisk') : t('recovery.restore.previewReady')}
                    description={t('recovery.restore.delta', {
                      delta: preflight.recordDelta,
                      loss: preflight.estimatedLoss,
                      expiresAt: formatDate(preflight.expiresAt),
                    })}
                  />

                  <Checkbox isSelected={riskAccepted} onValueChange={setRiskAccepted} isDisabled={busy}>
                    {t('recovery.restore.acceptRisk')}
                  </Checkbox>
                  <Input
                    label={t('recovery.restore.confirmLabel')}
                    description={t('recovery.restore.confirmDescription', { id: logBookId })}
                    value={confirmation}
                    onValueChange={setConfirmation}
                    isDisabled={busy}
                    autoComplete="off"
                  />
                  <Button
                    color="danger"
                    isDisabled={busy || !canRestore}
                    isLoading={pendingAction === 'restore'}
                    onPress={() => {
                      void run('restore', () => onRestore(preflight.preflightToken, preflight.revision));
                    }}
                  >
                    {t('recovery.restore.confirm')}
                  </Button>
                </div>
              )}
            </section>
          )}
        </ModalBody>

        <ModalFooter className="border-t border-default-200">
          <Button variant="light" isDisabled={busy} onPress={() => { void run('refresh', onRefresh); }}>
            {t('recovery.refresh')}
          </Button>
          <Button variant="flat" isDisabled={busy} onPress={onClose}>
            {t('common:button.close')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default LogbookRecoveryModal;
