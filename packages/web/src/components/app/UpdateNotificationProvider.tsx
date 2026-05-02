import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { SystemUpdateStatus } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { UserRole } from '@tx5dr/contracts';
import { useAuth, useHasMinRole } from '../../store/authStore';
import { useConnection } from '../../store/radioStore';
import { createLogger } from '../../utils/logger';

const logger = createLogger('UpdateNotificationProvider');
const UPDATE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SEEN_PREFIX = 'tx5dr_update_seen';

type UpdateStatusWithDownloads = SystemUpdateStatus & {
  checking?: boolean;
  recentCommits?: Array<{ id: string; shortId: string; title: string; publishedAt: string | null }>;
  downloadUrl?: string | null;
  downloadOptions?: Array<{
    name: string;
    url: string;
    packageType: string;
    platform: string;
    arch: string;
    recommended: boolean;
    source: 'oss' | 'github';
  }>;
  downloadSource?: 'oss' | 'github' | null;
};

interface UpdateNotificationContextValue {
  status: UpdateStatusWithDownloads | null;
  isUnreadUpdateAvailable: boolean;
  refresh: () => Promise<UpdateStatusWithDownloads | null>;
  markCurrentAsRead: () => void;
}

const UpdateNotificationContext = createContext<UpdateNotificationContextValue | null>(null);

function getSeenKey(status: Pick<SystemUpdateStatus, 'target' | 'identity'>): string | null {
  if (!status.identity) return null;
  return `${SEEN_PREFIX}:${status.target}:${status.identity}`;
}

function isSeen(status: SystemUpdateStatus): boolean {
  const key = getSeenKey(status);
  if (!key) return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function normalizeElectronStatus(status: DesktopUpdateStatus): UpdateStatusWithDownloads {
  return {
    ...status,
    currentDigest: null,
    latestDigest: null,
    websiteUrl: status.websiteUrl || 'https://tx5dr.com',
  };
}

async function fetchUpdateStatus(): Promise<UpdateStatusWithDownloads | null> {
  if (window.electronAPI?.updater?.check) {
    return normalizeElectronStatus(await window.electronAPI.updater.check());
  }
  return api.getSystemUpdateStatus();
}

export function UpdateNotificationProvider({ children }: { children: React.ReactNode }) {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const { state: authState } = useAuth();
  const { state: connectionState } = useConnection();
  const [status, setStatus] = useState<UpdateStatusWithDownloads | null>(null);
  const [seenNonce, setSeenNonce] = useState(0);

  const enabled = isAdmin && authState.initialized && connectionState.wasEverConnected;

  const refresh = useCallback(async () => {
    if (!enabled) return null;
    try {
      const next = await fetchUpdateStatus();
      setStatus(next);
      return next;
    } catch (error) {
      logger.warn('update notification refresh failed', error);
      return null;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return undefined;
    }

    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, UPDATE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [enabled, refresh]);

  const markCurrentAsRead = useCallback(() => {
    if (!status?.updateAvailable) return;
    const key = getSeenKey(status);
    if (!key) return;
    try {
      window.localStorage.setItem(key, '1');
      setSeenNonce((value) => value + 1);
    } catch {
      // Ignore storage errors; the update card is still accessible.
    }
  }, [status]);

  const isUnreadUpdateAvailable = useMemo(() => {
    void seenNonce;
    return Boolean(status?.updateAvailable && status.identity && !isSeen(status));
  }, [status, seenNonce]);

  const value = useMemo<UpdateNotificationContextValue>(() => ({
    status,
    isUnreadUpdateAvailable,
    refresh,
    markCurrentAsRead,
  }), [status, isUnreadUpdateAvailable, refresh, markCurrentAsRead]);

  return (
    <UpdateNotificationContext.Provider value={value}>
      {children}
    </UpdateNotificationContext.Provider>
  );
}

export function useUpdateNotification(): UpdateNotificationContextValue {
  const context = useContext(UpdateNotificationContext);
  if (context) return context;
  return {
    status: null,
    isUnreadUpdateAvailable: false,
    refresh: async () => null,
    markCurrentAsRead: () => undefined,
  };
}

export type { UpdateStatusWithDownloads };
