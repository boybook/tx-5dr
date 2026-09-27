import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Checkbox, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader,
  Select, SelectItem, Spinner,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faArrowRight, faRotate, faList, faCloudArrowUp, faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type {
  IncompleteQsoCandidate, IncompleteQsoJob, IncompleteQsoPreviewItem,
  IncompleteQsoQuery, IncompleteQsoSummary,
} from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { isElectron, isMacOS } from '../../utils/config';

type Status = IncompleteQsoQuery['status'];

export default function IncompleteQsoReview({ logBookId, writable, onBack, onRecorded, onOpenQso }: {
  logBookId: string;
  writable: boolean;
  onBack: () => void;
  onRecorded: () => void;
  onOpenQso: (callsign: string) => void;
}) {
  const { t } = useTranslation('logbook');
  const macElectron = isElectron() && isMacOS();
  const [status, setStatus] = useState<Status>('pending');
  const [callsign, setCallsign] = useState('');
  const [callsignDraft, setCallsignDraft] = useState('');
  const [mode, setMode] = useState<'all' | 'FT8' | 'FT4'>('all');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [items, setItems] = useState<IncompleteQsoSummary[]>([]);
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{ state: string; dropped: number } | null>(null);
  const [detail, setDetail] = useState<IncompleteQsoCandidate | null>(null);
  const [preview, setPreview] = useState<IncompleteQsoPreviewItem[] | null>(null);
  const [job, setJob] = useState<IncompleteQsoJob | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const query: Partial<IncompleteQsoQuery> = {
        status, callsign: callsign || undefined, mode: mode === 'all' ? undefined : mode,
        from: from ? Date.parse(`${from}T00:00:00Z`) : undefined,
        until: until ? Date.parse(`${until}T23:59:59Z`) : undefined,
        cursor, limit: 50,
      };
      const [list, currentHealth] = await Promise.all([
        api.getIncompleteQsoCandidates(logBookId, query), api.getIncompleteQsoHealth(logBookId),
      ]);
      setItems(list.data.items);
      setNextCursor(list.data.nextCursor);
      setHealth(currentHealth.data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('review.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [logBookId, status, callsign, mode, from, until, cursor, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (callsignDraft === callsign) return;
    const timer = window.setTimeout(() => {
      setCallsign(callsignDraft);
      setCursor(undefined);
      setCursorStack([]);
      setSelected(new Map());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [callsignDraft, callsign]);

  useEffect(() => {
    if (!job || job.state === 'finished') return;
    const timer = window.setTimeout(() => {
      void api.getIncompleteQsoJob(logBookId, job.id).then(response => {
        if (response.data) {
          setJob(response.data);
          if (response.data.state === 'finished') {
            setSelected(new Map());
            void refresh();
            onRecorded();
          }
        }
      }).catch(cause => setError(cause instanceof Error ? cause.message : t('review.loadFailed')));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [job, logBookId, refresh, onRecorded, t]);

  const resetPage = () => { setCursor(undefined); setCursorStack([]); setSelected(new Map()); };
  const selection = { items: [...selected].map(([id, revision]) => ({ id, revision })) };

  const openPreview = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      setPreview((await api.previewIncompleteQsos(logBookId, selection)).data.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('review.previewFailed'));
    } finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const response = await api.commitIncompleteQsos(logBookId, selection);
      setJob({ id: response.data.jobId, state: 'running', items: [] });
      setPreview(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('review.commitFailed'));
    } finally { setBusy(false); }
  };

  const dismiss = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      await api.dismissIncompleteQsos(logBookId, selection);
      setSelected(new Map());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('review.commitFailed'));
    } finally { setBusy(false); }
  };

  const viewDetail = async (id: string) => {
    try {
      setDetail((await api.getIncompleteQsoCandidate(logBookId, id)).data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('review.loadFailed'));
    }
  };

  return (
    <section className={`mx-auto max-w-7xl space-y-4 px-3 pb-5 md:px-6 ${macElectron ? 'pt-11 md:pt-12' : 'pt-5'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="light" startContent={<FontAwesomeIcon icon={faArrowLeft} />}
            onPress={onBack}>{t('review.qsoView')}</Button>
          <h2 className="text-lg font-semibold">{t('review.title')}</h2>
        </div>
        <Button size="sm" isIconOnly variant="light" title={t('review.refresh')} aria-label={t('review.refresh')}
          onPress={() => { void refresh(); }}><FontAwesomeIcon icon={faRotate} /></Button>
      </div>
      {health && (health.state !== 'ready' || health.dropped > 0) && (
        <Alert color="warning" title={t('review.captureWarning')} description={t('review.captureWarningDetail', { count: health.dropped })} />
      )}
      {error && <Alert color="danger" title={t('review.error')} description={error} />}
      <div className="flex flex-wrap gap-2 items-end">
        <Select size="sm" className="w-40" label={t('review.status')} selectedKeys={[status]}
          onSelectionChange={keys => { const value = [...keys][0] as Status; if (value) { setStatus(value); resetPage(); } }}>
          <SelectItem key="pending">{t('review.pending')}</SelectItem>
          <SelectItem key="recorded">{t('review.recorded')}</SelectItem>
          <SelectItem key="dismissed">{t('review.dismissed')}</SelectItem>
        </Select>
        <Input size="sm" className="w-40" label={t('review.callsign')} value={callsignDraft}
          onValueChange={value => setCallsignDraft(value.toUpperCase())} />
        <Select size="sm" className="w-32" label={t('review.mode')} selectedKeys={[mode]}
          onSelectionChange={keys => { const value = [...keys][0] as typeof mode; if (value) { setMode(value); resetPage(); } }}>
          <SelectItem key="all">{t('review.all')}</SelectItem>
          <SelectItem key="FT8">FT8</SelectItem>
          <SelectItem key="FT4">FT4</SelectItem>
        </Select>
        <Input size="sm" type="date" className="w-40" label={t('review.from')} value={from}
          onValueChange={value => { setFrom(value); resetPage(); }} />
        <Input size="sm" type="date" className="w-40" label={t('review.until')} value={until}
          onValueChange={value => { setUntil(value); resetPage(); }} />
      </div>
      {status === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-default-500">{t('review.selected', { count: selected.size })}</span>
          <Button size="sm" color="primary" isDisabled={!writable || selected.size === 0 || busy}
            onPress={() => { void openPreview(); }}>{t('review.preview')}</Button>
          <Button size="sm" variant="flat" isDisabled={!writable || selected.size === 0 || busy}
            onPress={() => { void dismiss(); }}>{t('review.dismiss')}</Button>
        </div>
      )}
      <div className="overflow-x-auto border border-default-200 rounded-md">
        <table className="w-full text-sm text-left min-w-[660px]">
          <thead className="bg-default-100 text-default-600"><tr>
            <th className="p-3 w-10">{status === 'pending' && <Checkbox aria-label={t('review.selectPage')}
              isSelected={items.length > 0 && items.every(item => selected.has(item.id))}
              onValueChange={checked => {
                const next = new Map(selected);
                for (const item of items) {
                  if (checked && next.size < 100) next.set(item.id, item.revision);
                  if (!checked) next.delete(item.id);
                }
                setSelected(next);
              }} />}</th>
            <th className="p-3">{t('review.time')}</th><th className="p-3">{t('review.callsign')}</th>
            <th className="p-3">{t('review.mode')}</th><th className="p-3">{t('review.frequency')}</th>
            <th className="p-3">{t('review.status')}</th><th className="p-3">{t('review.actions')}</th>
          </tr></thead>
          <tbody>
            {items.map(item => <tr key={item.id} className="border-t border-default-200 hover:bg-default-50">
              <td className="p-3">{status === 'pending' && <Checkbox aria-label={item.callsign}
                isSelected={selected.has(item.id)} isDisabled={!selected.has(item.id) && selected.size >= 100}
                onValueChange={checked => {
                  const next = new Map(selected);
                  if (checked) next.set(item.id, item.revision); else next.delete(item.id);
                  setSelected(next);
                }} />}</td>
              <td className="p-3 whitespace-nowrap font-mono">{new Date(item.startTime).toISOString().replace('T', ' ').slice(0, 16)}Z</td>
              <td className="p-3 font-mono font-medium">{item.callsign}</td>
              <td className="p-3">{item.mode}</td>
              <td className="p-3 font-mono">{(item.frequency / 1e6).toFixed(6)}</td>
              <td className="p-3">{t(`review.${item.status}`)}</td>
              <td className="p-3 flex gap-1"><Button size="sm" variant="light" isIconOnly title={t('review.messages')}
                aria-label={t('review.messages')} onPress={() => { void viewDetail(item.id); }}><FontAwesomeIcon icon={faList} /></Button>
                {item.linkedQsoId && <Button size="sm" variant="light" isIconOnly
                  title={t('review.openQso')} aria-label={t('review.openQso')}
                  onPress={() => onOpenQso(item.callsign)}><FontAwesomeIcon icon={faArrowUpRightFromSquare} /></Button>}
                {item.status === 'recorded' && !item.syncQueued && <Button size="sm" variant="light" isIconOnly
                  title={t('review.retrySync')} aria-label={t('review.retrySync')}
                  onPress={() => { void api.retryIncompleteQsoSync(logBookId, item.id).then(refresh).catch(cause => setError(String(cause))); }}>
                  <FontAwesomeIcon icon={faCloudArrowUp} /></Button>}</td>
            </tr>)}
          </tbody>
        </table>
        {loading && <div className="p-6 flex justify-center"><Spinner size="sm" /></div>}
        {!loading && items.length === 0 && <p className="p-6 text-center text-default-500">{t('review.empty')}</p>}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" isIconOnly variant="flat" title={t('review.previous')} aria-label={t('review.previous')}
          isDisabled={cursorStack.length === 0} onPress={() => {
            const stack = [...cursorStack]; setCursor(stack.pop()); setCursorStack(stack);
          }}><FontAwesomeIcon icon={faArrowLeft} /></Button>
        <Button size="sm" isIconOnly variant="flat" title={t('review.next')} aria-label={t('review.next')}
          isDisabled={!nextCursor} onPress={() => { setCursorStack([...cursorStack, cursor]); setCursor(nextCursor); }}>
          <FontAwesomeIcon icon={faArrowRight} /></Button>
      </div>
      {job && <Alert color={job.state === 'running' ? 'primary' : 'success'}
        title={job.state === 'running' ? t('review.running') : t('review.finished')}
        description={job.items.map(item => `${item.id.slice(0, 8)}: ${t(`review.result.${item.disposition}`)}${item.error ? ` (${item.error})` : ''}`).join(' | ')} />}
      <Modal isOpen={!!detail} onClose={() => setDetail(null)} size="2xl" scrollBehavior="inside">
        <ModalContent><ModalHeader>{detail?.callsign} | {t('review.messages')}</ModalHeader><ModalBody>
          <div className="space-y-1 text-sm font-mono">
            {detail?.messages.map((message, index) => <div key={`${message.slotStartMs}-${index}`}
              className="grid grid-cols-[6rem_2rem_minmax(0,1fr)] gap-2 border-b border-default-100 py-2">
              <span>{new Date(message.slotStartMs).toISOString().slice(11, 19)}</span>
              <span className={message.direction === 'tx' ? 'text-primary' : 'text-success'}>{message.direction.toUpperCase()}</span>
              <span className="min-w-0"><span className="break-all">{message.text}</span>
                <span className="block text-xs text-default-500">{t('review.audioOffset')}: {message.audioOffsetHz} Hz
                  {message.snr !== undefined ? ` | ${t('review.snr')}: ${message.snr} dB` : ''}</span>
              </span>
            </div>)}
          </div>
        </ModalBody></ModalContent>
      </Modal>
      <Modal isOpen={!!preview} onClose={() => setPreview(null)} size="3xl" scrollBehavior="inside">
        <ModalContent><ModalHeader>{t('review.previewTitle')}</ModalHeader><ModalBody>
          <div className="space-y-2 text-sm">
            {preview?.map(item => <div key={item.id} className="grid grid-cols-[1fr_auto] gap-2 border-b border-default-100 py-2">
              <div><span className="font-mono font-medium">{item.candidate?.callsign ?? item.id}</span>
                {item.candidate && <span className="ml-2 text-default-500">{new Date(item.candidate.startTime).toISOString().slice(0, 16)}Z | {item.candidate.mode} | {(item.candidate.frequency / 1e6).toFixed(6)} MHz | {item.candidate.reportSent}/{item.candidate.reportReceived}</span>}
              </div><span className={item.disposition === 'ready' ? 'text-success' : 'text-warning'}>
                {t(`review.result.${item.disposition}`)}</span>
            </div>)}
          </div>
        </ModalBody><ModalFooter>
          <Button variant="flat" onPress={() => setPreview(null)}>{t('review.cancel')}</Button>
          <Button color="primary" isLoading={busy} isDisabled={!preview?.some(item => item.disposition === 'ready')}
            onPress={() => { void commit(); }}>{t('review.confirm')}</Button>
        </ModalFooter></ModalContent>
      </Modal>
    </section>
  );
}
