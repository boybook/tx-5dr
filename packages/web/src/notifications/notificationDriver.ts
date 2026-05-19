import type { QSORecord } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';

const logger = createLogger('NotificationDriver');
const ANDROID_PERMISSION_TIMEOUT_MS = 60_000;

export type BrowserNotificationPermission = 'default' | 'granted' | 'denied';
export type NotificationPermissionState = BrowserNotificationPermission | 'unsupported';

export interface SystemNotificationPayload {
  title: string;
  body: string;
  tag?: string;
}

export interface SystemNotificationHandle {
  close(): void;
  onclick: ((event?: Event) => void) | null;
}

interface AndroidNotificationBridge {
  getPermission(): BrowserNotificationPermission | string;
  requestPermission(requestId: string): BrowserNotificationPermission | string | void;
  showNotification(payloadJson: string): boolean;
  openSettings?(): void;
}

declare global {
  interface Window {
    Tx5drAndroidNotifications?: AndroidNotificationBridge;
    __tx5drAndroidNotificationPermissionResult?: (requestId: string, permission: BrowserNotificationPermission | string) => void;
  }
}

let nativePermissionRequestCounter = 0;
let nativePermissionCallbackInstalled = false;
const pendingNativePermissionRequests = new Map<string, (permission: NotificationPermissionState) => void>();

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isBrowserNotificationAvailable(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

function getAndroidNotificationBridge(): AndroidNotificationBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.Tx5drAndroidNotifications;
  if (!bridge || typeof bridge.getPermission !== 'function' || typeof bridge.showNotification !== 'function') {
    return null;
  }
  return bridge;
}

function normalizePermission(permission: unknown): NotificationPermissionState {
  return permission === 'granted' || permission === 'denied' || permission === 'default'
    ? permission
    : 'unsupported';
}

function getAndroidNotificationPermissionState(): NotificationPermissionState {
  const bridge = getAndroidNotificationBridge();
  if (!bridge) return 'unsupported';

  try {
    return normalizePermission(bridge.getPermission());
  } catch (error) {
    logger.warn('Failed to query Android notification permission', error);
    return 'unsupported';
  }
}

function ensureNativePermissionCallback(): void {
  if (nativePermissionCallbackInstalled || typeof window === 'undefined') return;
  nativePermissionCallbackInstalled = true;
  window.__tx5drAndroidNotificationPermissionResult = (requestId, permission) => {
    const resolve = pendingNativePermissionRequests.get(requestId);
    if (!resolve) return;
    pendingNativePermissionRequests.delete(requestId);
    resolve(normalizePermission(permission));
  };
}

async function requestAndroidNotificationPermission(): Promise<NotificationPermissionState> {
  const bridge = getAndroidNotificationBridge();
  if (!bridge || typeof bridge.requestPermission !== 'function') return 'unsupported';

  const before = getAndroidNotificationPermissionState();
  if (before === 'granted' || before === 'denied') return before;

  ensureNativePermissionCallback();
  const requestId = `native-${Date.now()}-${nativePermissionRequestCounter++}`;

  return await new Promise<NotificationPermissionState>((resolve) => {
    const timeout = window.setTimeout(() => {
      pendingNativePermissionRequests.delete(requestId);
      resolve(getAndroidNotificationPermissionState());
    }, ANDROID_PERMISSION_TIMEOUT_MS);

    pendingNativePermissionRequests.set(requestId, (permission) => {
      window.clearTimeout(timeout);
      resolve(permission);
    });

    try {
      const immediate = normalizePermission(bridge.requestPermission(requestId));
      if (immediate === 'granted' || immediate === 'denied') {
        pendingNativePermissionRequests.delete(requestId);
        window.clearTimeout(timeout);
        resolve(immediate);
      }
    } catch (error) {
      pendingNativePermissionRequests.delete(requestId);
      window.clearTimeout(timeout);
      logger.warn('Failed to request Android notification permission', error);
      resolve(getAndroidNotificationPermissionState());
    }
  });
}

export function isNotificationSupported(): boolean {
  return getAndroidNotificationBridge() !== null || isBrowserNotificationAvailable();
}

export function isNotificationSecureContext(): boolean {
  if (getAndroidNotificationBridge() !== null) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return window.isSecureContext || isLoopbackHostname(window.location.hostname);
}

export function getNotificationPermissionState(): NotificationPermissionState {
  const androidPermission = getAndroidNotificationPermissionState();
  if (androidPermission !== 'unsupported') {
    return androidPermission;
  }

  if (!isBrowserNotificationAvailable() || !isNotificationSecureContext()) {
    return 'unsupported';
  }

  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const bridge = getAndroidNotificationBridge();
  if (bridge) {
    return requestAndroidNotificationPermission();
  }

  if (!isBrowserNotificationAvailable() || !isNotificationSecureContext()) {
    return 'unsupported';
  }

  try {
    return await Notification.requestPermission();
  } catch (error) {
    logger.warn('Failed to request notification permission', error);
    return Notification.permission;
  }
}

export function showSystemNotification(payload: SystemNotificationPayload): SystemNotificationHandle | null {
  const bridge = getAndroidNotificationBridge();
  if (bridge) {
    if (getAndroidNotificationPermissionState() !== 'granted') {
      return null;
    }

    try {
      const shown = bridge.showNotification(JSON.stringify({
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
      }));
      if (!shown) return null;
      return {
        onclick: null,
        close() {},
      };
    } catch (error) {
      logger.warn('Failed to show Android notification', error);
      return null;
    }
  }

  if (getNotificationPermissionState() !== 'granted') {
    return null;
  }

  try {
    return new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      silent: false,
    }) as SystemNotificationHandle;
  } catch (error) {
    logger.warn('Failed to show system notification', error);
    return null;
  }
}

export function openSystemNotificationSettings(): boolean {
  const bridge = getAndroidNotificationBridge();
  if (!bridge?.openSettings) return false;
  try {
    bridge.openSettings();
    return true;
  } catch (error) {
    logger.warn('Failed to open Android notification settings', error);
    return false;
  }
}

export function isDocumentInBackground(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  return document.visibilityState !== 'visible' || !document.hasFocus();
}

export function buildQsoNotificationSummary(qso: Pick<QSORecord, 'callsign' | 'grid' | 'frequency' | 'mode' | 'reportSent' | 'reportReceived'>): string {
  const summaryParts = [qso.callsign];

  if (qso.grid) {
    summaryParts.push(qso.grid);
  }

  if (typeof qso.frequency === 'number' && qso.frequency > 0) {
    summaryParts.push(`${(qso.frequency / 1_000_000).toFixed(3)} MHz`);
  }

  if (qso.mode) {
    summaryParts.push(qso.mode);
  }

  if (qso.reportSent || qso.reportReceived) {
    summaryParts.push(`${qso.reportSent || '--'}/${qso.reportReceived || '--'}`);
  }

  return summaryParts.join(' • ');
}
