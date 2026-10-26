/// <reference types="@tx5dr/plugin-api/bridge" />
import { useEffect, useRef, useState } from 'react';
import { SyncStatusSchema, type SyncStatus } from '@tx5dr/contracts';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

const I18N = {
  zh: { automaticUpload: '自动上传', close: '关闭', details: '查看全部错误', next: '下一页', previous: '上一页', sync: '同步', upload: '上传', download: '下载', reconcile: '重新对账', start: '重试', existing: '已有其他同步操作暂停，请先继续原操作。', inspect: '上次同步结果', noActivity: '尚未执行同步', advanced: '高级操作', resume: '继续同步', pause: '暂停',
    idle: '尚未同步', running: '执行中', waiting: '等待', pausing: '正在暂停', paused: '已暂停', completed: '同步完成',
    partial_failure: '部分失败', failed: '同步失败', interrupted: '同步已中断', preparing: '准备', downloading: '下载', reconciling: '对账',
    uploading: '上传', confirming: '刷新确认', committing: '保存日志', finished: '结束', unavailable: '状态暂不可用',
    downloaded: '下载', imported: '导入', uploaded: '上传', skipped: '跳过', failures: '失败', conflicts: '冲突', rejected: '已忽略', updated: '确认更新',
    processed: '已处理', closeHint: '关闭页面后完成当前批次即暂停，重新打开可继续。', lastConfirmation: '确认刷新', lastSuccess: '最近成功', retry: '下次尝试', updatedAt: '状态更新时间' },
  en: { automaticUpload: 'Automatic upload', close: 'Close', details: 'View all errors', next: 'Next', previous: 'Previous', sync: 'Sync', upload: 'Upload', download: 'Download', reconcile: 'Reconcile', start: 'Retry', existing: 'Another operation is paused. Continue that operation first.', inspect: 'Last sync result', noActivity: 'No synchronization yet', advanced: 'Advanced', resume: 'Continue', pause: 'Pause',
    idle: 'Not synchronized', running: 'Running', waiting: 'Waiting', pausing: 'Pausing', paused: 'Paused', completed: 'Completed',
    partial_failure: 'Partial failure', failed: 'Failed', interrupted: 'Interrupted', preparing: 'Preparing', downloading: 'Downloading', reconciling: 'Reconciling',
    uploading: 'Uploading', confirming: 'Refreshing confirmations', committing: 'Saving logbook', finished: 'Finished', unavailable: 'Status unavailable',
    downloaded: 'Downloaded', imported: 'Imported', uploaded: 'Uploaded', skipped: 'Skipped', failures: 'Failed', conflicts: 'Conflicts', rejected: 'Ignored', updated: 'Confirmations updated',
    processed: 'Processed', closeHint: 'Closing pauses after the current batch commits. Reopen to continue.', lastConfirmation: 'Confirmations refreshed', lastSuccess: 'Last success', retry: 'Next attempt', updatedAt: 'Status updated' },
  ja: { automaticUpload: '自動アップロード', close: '閉じる', details: 'すべてのエラー', next: '次へ', previous: '前へ', sync: '同期', upload: 'アップロード', download: 'ダウンロード', reconcile: '再照合', start: '再試行', existing: '別の処理が一時停止中です。先にその処理を続行してください。', inspect: '前回の結果', noActivity: '同期はまだ実行されていません', advanced: '詳細操作', resume: '同期を続行', pause: '一時停止',
    idle: '未同期', running: '実行中', waiting: '待機中', pausing: '停止処理中', paused: '一時停止', completed: '完了',
    partial_failure: '一部失敗', failed: '失敗', interrupted: '中断', preparing: '準備', downloading: 'ダウンロード', reconciling: '照合',
    uploading: 'アップロード', confirming: '確認を更新', committing: 'ログを保存', finished: '終了', unavailable: '状態を取得できません',
    downloaded: 'ダウンロード', imported: '追加', uploaded: 'アップロード', skipped: 'スキップ', failures: '失敗', conflicts: '競合', rejected: '除外', updated: '確認更新',
    processed: '処理済み', closeHint: '画面を閉じると現在のバッチ保存後に停止します。再度開いて続行できます。', lastConfirmation: '確認更新日時', lastSuccess: '最終成功', retry: '次回試行', updatedAt: '状態更新日時' },
};
type Step = { status: SyncStatus; step: number };
function decodeStep(value: unknown): Step {
  if (!value || typeof value !== 'object') throw new Error('Invalid sync response');
  const data = value as Step;
  if (!Number.isSafeInteger(data.step) || data.step < 0) throw new Error('Invalid sync step');
  return { status: SyncStatusSchema.parse(data.status), step: data.step };
}
export function App({ entry }: { entry?: { intent: string; operation: string; launchId: string } } = {}) {
  const t = useI18n(I18N); useAutoResize();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [automatic, setAutomatic] = useState<SyncStatus | null>(null);
  const [error, setError] = useState('');
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [driving, setDriving] = useState(false);
  const [ready, setReady] = useState(false);
  const [details, setDetails] = useState<{ errors: Array<{ code: string; message: string; qsoCallsign?: string }>; total: number; offset: number } | null>(null);
  const mounted = useRef(true); const running = useRef(false); const current = useRef<Step | null>(null);
  const started = useRef(false); const detailRequest = useRef(0);
  const apply = (next: SyncStatus) => setStatus(previous => previous && previous.instanceId === next.instanceId
    && (previous.startedAt > next.startedAt || previous.operationId === next.operationId && previous.revision > next.revision) ? previous : next);
  useEffect(() => { detailRequest.current++; setDetails(null); }, [status?.operationId]);

  const execute = async (operation: SyncStatus['operation'], launchId?: string) => {
    if (running.current) return;
    running.current = true; setDriving(true); setError('');
    try {
      let next = decodeStep(await window.tx5dr.invoke('beginSync', { operation, ...(launchId ? { launchId } : {}) }));
      current.current = next;
      if (!mounted.current) return;
      apply(next.status);
      while (mounted.current && running.current && next.status.resumable) {
        if (next.status.nextAttemptAt && next.status.nextAttemptAt > Date.now()) {
          await new Promise(resolve => setTimeout(resolve, Math.min(500, next.status.nextAttemptAt! - Date.now()))); continue;
        }
        next = decodeStep(await window.tx5dr.invoke('advanceSync', { operationId: next.status.operationId, step: next.step }));
        current.current = next;
        if (mounted.current) apply(next.status);
        if (['failed', 'partial_failure', 'paused', 'interrupted'].includes(next.status.state)) break;
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('unavailable')); }
    finally { running.current = false; if (mounted.current) setDriving(false); }
  };
  useEffect(() => {
    let live = true; mounted.current = true; let polling = false; let initialized = false;
    const initialize = async () => {
      await window.tx5dr.ready;
      if (!live) return;
      const { intent, operation, launchId } = entry ?? window.tx5dr.params;
      let raw: unknown;
      try { raw = await window.tx5dr.invoke('getSyncStatus'); }
      catch (cause) { if (intent !== 'start' || operation !== 'reconcile') throw cause; }
      if (!live) return;
      const previous = raw ? SyncStatusSchema.parse(raw) : null;
      if (previous) apply(previous);
      let auto: unknown;
      try { auto = await window.tx5dr.invoke('getAutomaticUploadStatus'); }
      catch (cause) { if (intent !== 'start' || operation !== 'reconcile') throw cause; }
      if (!live) return;
      if (auto && typeof auto === 'object' && 'trigger' in auto && auto.trigger === 'auto') setAutomatic(SyncStatusSchema.parse(auto));
      setReady(true); initialized = true;
      if (!started.current && ['start', 'resume'].includes(intent ?? '')) {
        started.current = true;
        const requested = ['upload', 'download', 'full_sync', 'reconcile'].includes(operation ?? '') ? operation as SyncStatus['operation'] : 'full_sync';
        if (previous?.resumable && requested !== previous.operation) { setError(t('existing')); return; }
        await execute(previous?.resumable ? previous.operation : requested, launchId);
      }
    };
    void initialize().catch(() => { if (live) { setReady(true); initialized = true; setStatusUnavailable(true); } });
    // One self-scheduling poll: terminal states and hidden tabs cost far less than 1 Hz.
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const schedule = (delay: number) => { clearTimeout(pollTimer); pollTimer = setTimeout(pollStatus, delay); };
    const pollStatus = async () => {
      if (!live || polling) { schedule(1000); return; }
      if (!initialized) { schedule(1000); return; }
      polling = true;
      try {
        const raw = await window.tx5dr.invoke('getSyncStatus');
        const auto = await window.tx5dr.invoke('getAutomaticUploadStatus');
        if (live) { if (raw) apply(SyncStatusSchema.parse(raw)); setAutomatic(auto && typeof auto === 'object' && 'trigger' in auto && auto.trigger === 'auto' ? SyncStatusSchema.parse(auto) : null); setStatusUnavailable(false); }
        failures = 0;
      } catch { failures += 1; if (live) setStatusUnavailable(true); }
      finally {
        polling = false;
        if (!live) return;
        const active = !!current.current && ['running', 'waiting', 'pausing'].includes(current.current.status.state);
        const delay = failures > 0 ? Math.min(2000 * 2 ** Math.min(failures - 1, 5), 60_000)
          : active ? 1000 : document.hidden ? 30_000 : 10_000;
        schedule(delay);
      }
    };
    const visible = () => { if (!document.hidden) schedule(0); };
    document.addEventListener('visibilitychange', visible);
    schedule(1000);
    return () => {
      live = false; mounted.current = false; running.current = false;
      clearTimeout(pollTimer); document.removeEventListener('visibilitychange', visible);
    };
    // Entry intent is processed once per iframe; language changes do not restart operations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!driving) return;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (!current.current || inFlight) return; inFlight = true;
      try { await window.tx5dr.invoke('renewSyncLease', { operationId: current.current.status.operationId }); }
      catch { running.current = false; if (mounted.current) { setDriving(false); setError(t('unavailable')); } }
      finally { inFlight = false; }
    }, 1000);
    return () => clearInterval(timer);
  }, [driving, t]);
  const pause = async () => {
    running.current = false;
    try { if (current.current) await window.tx5dr.invoke('pauseSync', { operationId: current.current.status.operationId }); }
    catch { setError(t('unavailable')); }
  };
  const loadDetails = async (offset: number) => {
    const requestId = ++detailRequest.current;
    try {
      const raw = await window.tx5dr.invoke('getSyncDetails', { offset, operationId: status?.operationId });
      if (!raw || typeof raw !== 'object') throw new Error('Invalid details response');
      const value = raw as { errors: Array<{ code: string; message: string; qsoCallsign?: string }>; total: number };
      if (!Number.isSafeInteger(value.total) || !Array.isArray(value.errors) || value.errors.some(item => typeof item.code !== 'string' || typeof item.message !== 'string')) throw new Error('Invalid details response');
      if (mounted.current && requestId === detailRequest.current) setDetails({ ...value, offset });
    } catch { if (mounted.current) setError(t('unavailable')); }
  };
  const active = !!status?.resumable && ['running', 'waiting', 'pausing'].includes(status.state);
  return <div className="sync-content">
    {!ready && <span className="tx5dr-spinner" aria-label={t('preparing')} />}
    {statusUnavailable && <p className="tx5dr-feedback tx5dr-feedback--danger" role="status">{t('unavailable')}{status ? ` · ${t('updatedAt')}: ${new Date(status.updatedAt).toLocaleString()}` : ''}</p>}
    {error && <p className="tx5dr-feedback tx5dr-feedback--danger" role="alert">{error}</p>}
    {ready && (!status || status.state === 'idle') && !error && <p className="tx5dr-muted">{t('noActivity')}</p>}
    {status && status.state !== 'idle' && <div aria-live="polite">
      <p className="sync-phase">{t(status.state)} · {t(status.stage)}</p>
      <p className="tx5dr-muted">{t('processed')}: {status.processed}{status.total === undefined ? '' : ` / ${status.total}`}</p>
      {status.total !== undefined && status.total > 0 && active && <progress className="tx5dr-progress" value={Math.min(status.processed, status.total)} max={status.total} />}
      <div className="sync-counts">
        {status.operation !== 'upload' && <div><span className="tx5dr-muted">{t('imported')}</span><strong>{status.imported}</strong></div>}
        {status.operation !== 'download' && <div><span className="tx5dr-muted">{t('uploaded')}</span><strong>{status.uploaded}</strong></div>}
        <div><span className="tx5dr-muted">{t('skipped')}</span><strong>{status.skipped}</strong></div>
      </div>
      <p className="tx5dr-muted">{t('failures')}: {status.failed} · {t('conflicts')}: {status.conflicts} · {t('rejected')}: {status.rejected} · {t('updated')}: {status.updated}</p>
      {status.nextAttemptAt && <p className="tx5dr-muted">{t('retry')}: {new Date(status.nextAttemptAt).toLocaleString()}</p>}
      {(status.errors.length > 0 || status.rejected > 0) && <button className="tx5dr-button" onClick={() => loadDetails(0)}>{t('details')}</button>}
      {details ? <div>
        {details.errors.map((item, index) => <p className={`tx5dr-feedback${item.code === 'wavelog_upload_rejected' ? '' : ' tx5dr-feedback--danger'}`} key={index}>{item.qsoCallsign ? `${item.qsoCallsign}: ` : ''}{item.message}</p>)}
        {details.offset > 0 && <button className="tx5dr-button" onClick={() => loadDetails(Math.max(0, details.offset - 50))}>{t('previous')}</button>}
        {details.offset + 50 < details.total && <button className="tx5dr-button" onClick={() => loadDetails(details.offset + 50)}>{t('next')}</button>}
      </div> : status.errors.map((item, i) => <p className="tx5dr-feedback tx5dr-feedback--danger" role="alert" key={i}>{item.message}</p>)}
    </div>}
    {automatic && automatic.failed > 0 && status?.trigger !== 'auto' && <section aria-label={t('automaticUpload')}>
      <p className="sync-phase">{t('automaticUpload')} · {t(automatic.state)} · {t('failures')}: {automatic.failed}</p>
      {automatic.errors.map((item, index) => <p key={index} className="tx5dr-feedback tx5dr-feedback--danger">{item.message}</p>)}
    </section>}
    <div className="tx5dr-actions">
      <span className="tx5dr-muted sync-close-hint">{driving ? t('closeHint') : ''}</span>
      {driving && <button className="tx5dr-button" onClick={pause}>{t('pause')}</button>}
      {!driving && status?.resumable && !active && <button className="tx5dr-button tx5dr-button--primary" onClick={() => execute(status.operation, window.tx5dr.params.launchId)}>{t('resume')}</button>}
      {!driving && !active && <button className="tx5dr-button" onClick={() => window.tx5dr.requestClose()}>{t('close')}</button>}
    </div>
  </div>;
}
