import { ServerMessageKey } from '@tx5dr/contracts';
import i18n from '../i18n/index';

type ToastColor = 'default' | 'foreground' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';

export interface ServerTextToastMessage {
  title: string;
  description: string;
  color?: ToastColor;
  timeout?: number;
  key?: string;
  params?: Record<string, string>;
  createdAtMs?: number;
}

export type ToastPresenter = (toast: {
  title: string;
  description?: string;
  color?: ToastColor;
  timeout?: number;
}) => void;

interface PendingQsoToastSummary {
  logged: number;
  updated: number;
  latestSummary: string;
}

export const QSO_TOAST_DRAIN_WINDOW_MS = 800;
export const QSO_TOAST_SUMMARY_TIMEOUT_MS = 5000;
const QSO_TOAST_CREATED_AT_BACKLOG_WINDOW_MS = 10_000;

let initialized = false;
let wasBackgrounded = false;
let lastVisibleAtMs = 0;
let drainUntilMs = 0;
let pendingSummary: PendingQsoToastSummary | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastPresenter: ToastPresenter | null = null;

function isQsoToastKey(key: string | undefined): key is ServerMessageKey.QSO_LOGGED | ServerMessageKey.QSO_UPDATED {
  return key === ServerMessageKey.QSO_LOGGED || key === ServerMessageKey.QSO_UPDATED;
}

function isDocumentInBackground(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  const isVisible = document.visibilityState === 'visible';
  const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  return !isVisible || !hasFocus;
}

function clearPendingTimer(): void {
  if (pendingTimer === null) {
    return;
  }

  clearTimeout(pendingTimer);
  pendingTimer = null;
}

function getMessageCreatedAtMs(message: ServerTextToastMessage): number | undefined {
  return typeof message.createdAtMs === 'number' && Number.isFinite(message.createdAtMs)
    ? message.createdAtMs
    : undefined;
}

function createSummaryDescription(summary: PendingQsoToastSummary): string {
  const params = {
    logged: String(summary.logged),
    updated: String(summary.updated),
    latestSummary: summary.latestSummary,
  };

  if (summary.logged > 0 && summary.updated > 0) {
    return i18n.t('toast:serverMessage.qsoSummary.descriptionMixed', params);
  }

  if (summary.logged > 0) {
    return i18n.t('toast:serverMessage.qsoSummary.descriptionLogged', params);
  }

  return i18n.t('toast:serverMessage.qsoSummary.descriptionUpdated', params);
}

function flushPendingSummary(): void {
  clearPendingTimer();

  if (!pendingSummary || isDocumentInBackground()) {
    return;
  }

  const summary = pendingSummary;
  pendingSummary = null;
  drainUntilMs = 0;

  lastPresenter?.({
    title: i18n.t('toast:serverMessage.qsoSummary.title'),
    description: createSummaryDescription(summary),
    color: 'success',
    timeout: QSO_TOAST_SUMMARY_TIMEOUT_MS,
  });
}

function scheduleSummaryFlush(): void {
  clearPendingTimer();

  if (isDocumentInBackground() || !lastPresenter) {
    return;
  }

  const delayMs = Math.max(0, drainUntilMs - Date.now());
  pendingTimer = setTimeout(flushPendingSummary, delayMs);
}

function handleVisibilityChange(): void {
  if (isDocumentInBackground()) {
    wasBackgrounded = true;
    clearPendingTimer();
    return;
  }

  if (!wasBackgrounded) {
    return;
  }

  wasBackgrounded = false;
  lastVisibleAtMs = Date.now();
  drainUntilMs = lastVisibleAtMs + QSO_TOAST_DRAIN_WINDOW_MS;
  scheduleSummaryFlush();
}

function ensureVisibilityTracking(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  wasBackgrounded = isDocumentInBackground();
  lastVisibleAtMs = wasBackgrounded ? 0 : Date.now();

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleVisibilityChange);
  window.addEventListener('pageshow', handleVisibilityChange);
  window.addEventListener('blur', handleVisibilityChange);
}

function addPendingQsoToast(message: ServerTextToastMessage): void {
  const latestSummary = message.params?.summary || message.description || message.title;

  if (!pendingSummary) {
    pendingSummary = {
      logged: 0,
      updated: 0,
      latestSummary,
    };
  }

  if (message.key === ServerMessageKey.QSO_UPDATED) {
    pendingSummary.updated += 1;
  } else {
    pendingSummary.logged += 1;
  }

  pendingSummary.latestSummary = latestSummary;
}

export function handleQsoToastAggregation(
  message: ServerTextToastMessage,
  showToast: ToastPresenter,
): boolean {
  ensureVisibilityTracking();
  lastPresenter = showToast;

  if (!isQsoToastKey(message.key)) {
    return false;
  }

  const now = Date.now();
  const createdAtMs = getMessageCreatedAtMs(message);
  // Server and browser clocks can differ, so only use createdAtMs as a stale
  // packet hint shortly after a foreground transition.
  const isBackloggedByTimestamp = createdAtMs !== undefined
    && lastVisibleAtMs > 0
    && createdAtMs < lastVisibleAtMs
    && now - lastVisibleAtMs <= QSO_TOAST_CREATED_AT_BACKLOG_WINDOW_MS;
  const isRecoveringFromBackground = drainUntilMs > now;

  if (!isDocumentInBackground() && !isRecoveringFromBackground && !isBackloggedByTimestamp && !pendingSummary) {
    return false;
  }

  addPendingQsoToast(message);

  if (!isDocumentInBackground()) {
    if (!isRecoveringFromBackground && isBackloggedByTimestamp) {
      drainUntilMs = now + QSO_TOAST_DRAIN_WINDOW_MS;
    }
    scheduleSummaryFlush();
  }

  return true;
}

export function resetQsoToastAggregatorForTests(): void {
  clearPendingTimer();
  pendingSummary = null;
  drainUntilMs = 0;
  lastVisibleAtMs = 0;
  wasBackgrounded = false;
  lastPresenter = null;

  if (initialized && typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleVisibilityChange);
    window.removeEventListener('pageshow', handleVisibilityChange);
    window.removeEventListener('blur', handleVisibilityChange);
  }

  initialized = false;
}
