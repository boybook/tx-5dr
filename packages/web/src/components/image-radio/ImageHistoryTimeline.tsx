import React, { useEffect, useMemo, useState } from 'react';
import { Button, ButtonGroup, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Spinner, Tooltip } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowDown,
  faArrowUp,
  faCheck,
  faDownload,
  faImages,
  faRepeat,
  faRotate,
  faTrash,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import { UserRole, type ImageHistoryEntry } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { useImageHistory, type ImageHistoryDirection } from '../../hooks/useImageHistory';
import { useSstvTxStart } from '../../hooks/useSstvTxStart';
import { useCurrentOperatorId, useOperators, useRadioModeState } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { formatFrequencyMHz } from '../../utils/frequencyMHz';
import { canResendImageHistoryEntry, historyEnvelopeSelection } from './imageHistoryResend';
import { groupImageHistoryByDay } from './imageHistoryGrouping';
import { SstvCaptureConfirmModal } from './SstvCaptureConfirmModal';

function historyFileName(entry: ImageHistoryEntry): string {
  const timestamp = new Date(entry.record.occurredAt).toISOString().replace(/[:.]/g, '-');
  const mode = entry.artifact.codecMode.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `tx5dr-${entry.record.direction}-${entry.artifact.family}-${mode}-${timestamp}.png`;
}

async function downloadBlob(blob: Blob, fileName: string, title: string): Promise<void> {
  const electronSaveFile = window.electronAPI?.fs?.saveFile;
  if (electronSaveFile) {
    await electronSaveFile({
      title,
      defaultName: fileName,
      filters: [{ name: 'PNG', extensions: ['png'] }],
      data: new Uint8Array(await blob.arrayBuffer()),
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function HistoryEntry({
  entry,
  canDelete,
  canResend,
  resendDisabled,
  downloading,
  deleting,
  resending,
  onDownload,
  onDelete,
  onResend,
}: {
  entry: ImageHistoryEntry;
  canDelete: boolean;
  canResend: boolean;
  resendDisabled: boolean;
  downloading: boolean;
  deleting: boolean;
  resending: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onResend: () => void;
}) {
  const { t } = useTranslation('image');
  const [url, setUrl] = useState<string | null>(null);
  const isTx = entry.record.direction === 'tx';
  const interrupted = isTx && entry.record.outcome === 'interrupted';

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void api.getImageArtifactBlob(entry.artifact.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry.artifact.id]);

  return (
    <div className="image-history-row group relative pl-7">
      <span className="absolute left-[0.31rem] top-5 z-[1] flex h-5 w-5 items-center justify-center rounded-full bg-content2 text-[9px] text-default-700 ring-2 ring-content1">
        <FontAwesomeIcon icon={isTx ? faArrowUp : faArrowDown} />
      </span>
      <div className="image-history-entry rounded-md bg-content2/60 p-2">
        <button
          type="button"
          className="image-history-thumb overflow-hidden rounded bg-black"
          onClick={() => url && window.open(url, '_blank')}
          aria-label={t('openRecord')}
        >
          {url
            ? <img src={url} alt="" className="h-full w-full object-contain" />
            : <span className="block h-full w-full animate-pulse bg-default-100" />}
        </button>
        <div className="flex min-w-0 flex-col justify-between gap-1 py-0.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-default-800">
                <span>{t(isTx ? 'sent' : 'received')}</span>
                {isTx ? (
                  <span className={interrupted ? 'text-warning-500' : entry.record.outcome === 'transmitting' ? 'text-default-500' : 'text-success-500'} title={t(interrupted ? 'txInterrupted' : entry.record.outcome === 'transmitting' ? 'txInProgress' : 'txCompleted')}>
                    <FontAwesomeIcon icon={interrupted ? faTriangleExclamation : faCheck} />
                  </span>
                ) : entry.record.truncated || !entry.record.complete ? (
                  <span className="text-warning-500" title={t('partialRecord')}><FontAwesomeIcon icon={faTriangleExclamation} /></span>
                ) : null}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-default-600">{entry.artifact.codecMode}</div>
            </div>
            <span className="shrink-0 text-[11px] text-default-500">
              {new Date(entry.record.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div className="flex min-w-0 items-end justify-between gap-2">
            <span className="truncate font-mono text-[11px] text-default-500">
              {formatFrequencyMHz(entry.artifact.frequency)} MHz{entry.artifact.radioMode ? ` · ${entry.artifact.radioMode}` : ''}
            </span>
            <div className="flex shrink-0 gap-0.5">
              {canResend ? (
                <Tooltip content={t('sendImage')} placement="top" delay={250} closeDelay={0}>
                  <span className="inline-flex">
                    <Button isIconOnly size="sm" variant="light" className="h-7 min-w-7 text-default-600" isLoading={resending} isDisabled={resendDisabled} onPress={onResend} aria-label={t('sendImage')}>
                      <FontAwesomeIcon icon={faRepeat} className="text-[11px]" />
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
              <Tooltip content={t('downloadRecord')} placement="top" delay={250} closeDelay={0}>
                <span className="inline-flex">
                  <Button isIconOnly size="sm" variant="light" className="h-7 min-w-7 text-default-600" isLoading={downloading} onPress={onDownload} aria-label={t('downloadRecord')}>
                    <FontAwesomeIcon icon={faDownload} className="text-[11px]" />
                  </Button>
                </span>
              </Tooltip>
              {canDelete ? (
                <Tooltip content={t('deleteRecord')} placement="top" delay={250} closeDelay={0}>
                  <span className="inline-flex">
                    <Button isIconOnly size="sm" variant="light" color="danger" className="h-7 min-w-7" isLoading={deleting} onPress={onDelete} aria-label={t('deleteRecord')}>
                      <FontAwesomeIcon icon={faTrash} className="text-[11px]" />
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ImageHistoryTimeline() {
  const { t, i18n } = useTranslation('image');
  const radioMode = useRadioModeState();
  const { currentOperatorId } = useCurrentOperatorId();
  const { operators } = useOperators();
  const operatorId = currentOperatorId ?? operators[0]?.id;
  const txStart = useSstvTxStart();
  const isFax = radioMode.currentMode?.name === 'FAX';
  const canDelete = useHasMinRole(UserRole.OPERATOR);
  const [direction, setDirection] = useState<ImageHistoryDirection>('all');
  const visibleDirection = isFax || !canDelete ? 'rx' : direction;
  const { entries, loading, loadingMore, error, hasMore, refresh, loadMore } = useImageHistory(visibleDirection);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<ImageHistoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const groups = useMemo(() => groupImageHistoryByDay(entries), [entries]);

  const download = async (entry: ImageHistoryEntry) => {
    setDownloadingId(entry.record.id);
    try {
      await downloadBlob(await api.getImageArtifactBlob(entry.artifact.id), historyFileName(entry), t('downloadRecord'));
    } catch {
      addToast({ title: t('recordDownloadFailed'), color: 'danger' });
    } finally {
      setDownloadingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteEntry) return;
    setDeleting(true);
    try {
      await api.deleteImageHistoryRecord(deleteEntry.record.id);
      setDeleteEntry(null);
      await refresh();
    } catch {
      addToast({ title: t('recordDeleteFailed'), color: 'danger' });
    } finally {
      setDeleting(false);
    }
  };

  const resend = (entry: ImageHistoryEntry) => {
    if (!canResendImageHistoryEntry(entry, operatorId) || entry.record.direction !== 'tx' || !operatorId) return;
    const expectedFrequency = radioMode.currentRadioFrequency;
    if (!expectedFrequency) {
      addToast({ title: t('txNotReady'), color: 'warning' });
      return;
    }
    const expectedRadioMode = radioMode.currentRadioMode ?? undefined;
    txStart.start(entry.record.id, async () => {
      const fallbackEnvelope = entry.record.direction === 'tx' && entry.record.envelope
        ? { enhancedPreamble: true, stationIdMode: 'fsk' as const }
        : (await api.getSstvTxPreferences(operatorId)).preferences;
      const blob = await api.getImageArtifactBlob(entry.artifact.id);
      const upload = await api.uploadSstvArtifact({
        file: blob,
        operatorId,
        mode: entry.artifact.codecMode,
        frequency: expectedFrequency,
        radioMode: expectedRadioMode,
      });
      return {
        artifactId: upload.artifact.id,
        operatorId,
        mode: entry.artifact.codecMode,
        expectedFrequency,
        envelope: historyEnvelopeSelection(entry, fallbackEnvelope),
      };
    });
  };

  return (
    <>
      <div className="image-history-timeline flex h-full min-h-0 flex-col gap-2">
        <div className="flex flex-shrink-0 items-center justify-between gap-2">
          {!isFax && canDelete ? (
            <ButtonGroup size="sm" variant="flat">
              {(['all', 'rx', 'tx'] as const).map((value) => (
                <Button
                  key={value}
                  className={`min-w-0 px-2.5 ${direction === value ? 'bg-default-200 text-foreground' : ''}`}
                  startContent={value === 'rx' ? <FontAwesomeIcon icon={faArrowDown} /> : value === 'tx' ? <FontAwesomeIcon icon={faArrowUp} /> : undefined}
                  onPress={() => setDirection(value)}
                >
                  {t(value === 'all' ? 'allRecords' : value === 'rx' ? 'received' : 'sent')}
                </Button>
              ))}
            </ButtonGroup>
          ) : <span />}
          <Button isIconOnly size="sm" variant="light" onPress={() => void refresh()} aria-label={t('refresh')} title={t('refresh')}>
            <FontAwesomeIcon icon={faRotate} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex h-full items-center justify-center"><Spinner size="sm" color="default" /></div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-default-500">
              <FontAwesomeIcon icon={faTriangleExclamation} />
              <Button size="sm" variant="flat" onPress={() => void refresh()}>{t('retry')}</Button>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-default-400">
              <FontAwesomeIcon icon={faImages} className="text-xl" />
              <span className="text-xs">{t('noRecords')}</span>
            </div>
          ) : (
            <div className="space-y-4 pb-2">
              {groups.map((group) => (
                <section key={group.dayStart}>
                  <div className="mb-1.5 pl-7 text-[11px] font-medium text-default-500">
                    {new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }).format(group.dayStart)}
                  </div>
                  <div className="image-history-group relative space-y-2">
                    {group.entries.map((entry) => (
                      <HistoryEntry
                        key={entry.record.id}
                        entry={entry}
                        canDelete={canDelete}
                        canResend={canResendImageHistoryEntry(entry, operatorId)}
                        resendDisabled={txStart.isBusy}
                        downloading={downloadingId === entry.record.id}
                        deleting={deleting && deleteEntry?.record.id === entry.record.id}
                        resending={txStart.starting && txStart.activeKey === entry.record.id}
                        onDownload={() => void download(entry)}
                        onDelete={() => setDeleteEntry(entry)}
                        onResend={() => resend(entry)}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {hasMore ? (
                <div className="flex justify-center pl-7">
                  <Button size="sm" variant="light" isLoading={loadingMore} onPress={() => void loadMore()}>{t('loadMore')}</Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <Modal isOpen={Boolean(deleteEntry)} onClose={() => { if (!deleting) setDeleteEntry(null); }} size="sm" placement="center">
        <ModalContent>
          <ModalHeader>{t('deleteRecord')}</ModalHeader>
          <ModalBody><p className="text-sm text-default-600">{t('deleteRecordConfirm')}</p></ModalBody>
          <ModalFooter>
            <Button variant="flat" isDisabled={deleting} onPress={() => setDeleteEntry(null)}>{t('common:button.cancel')}</Button>
            <Button color="danger" isLoading={deleting} onPress={() => void confirmDelete()}>{t('common:button.delete')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <SstvCaptureConfirmModal
        isOpen={txStart.captureConfirmOpen}
        onCancel={txStart.cancelCaptureConfirmation}
        onConfirm={txStart.confirmCaptureInterrupt}
      />
    </>
  );
}
