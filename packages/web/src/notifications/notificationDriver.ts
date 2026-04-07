import type { QSORecord } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';

const logger = createLogger('NotificationDriver');

export type BrowserNotificationPermission = 'default' | 'granted' | 'denied';
export type NotificationPermissionState = BrowserNotificationPermission | 'unsupported';

export interface SystemNotificationPayload {
  title: string;
  body: string;
  tag?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

export function isNotificationSecureContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.isSecureContext || isLoopbackHostname(window.location.hostname);
}

export function getNotificationPermissionState(): NotificationPermissionState {
  if (!isNotificationSupported() || !isNotificationSecureContext()) {
    return 'unsupported';
  }

  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNotificationSupported() || !isNotificationSecureContext()) {
    return 'unsupported';
  }

  try {
    return await Notification.requestPermission();
  } catch (error) {
    logger.warn('Failed to request notification permission', error);
    return Notification.permission;
  }
}

export function showSystemNotification(payload: SystemNotificationPayload): Notification | null {
  if (getNotificationPermissionState() !== 'granted') {
    return null;
  }

  try {
    return new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      silent: false,
    });
  } catch (error) {
    logger.warn('Failed to show system notification', error);
    return null;
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
