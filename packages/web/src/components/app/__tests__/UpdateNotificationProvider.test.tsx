// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemUpdateStatus } from '@tx5dr/contracts';
import { UpdateNotificationProvider, useUpdateNotification } from '../UpdateNotificationProvider';

const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@tx5dr/core', () => ({ api: { getSystemUpdateStatus: mocks.check } }));
vi.mock('../../../store/authStore', () => ({
  useHasMinRole: () => true,
  useAuth: () => ({ state: { initialized: true } }),
}));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { wasEverConnected: true } }),
}));

function status(overrides: Partial<SystemUpdateStatus> = {}): SystemUpdateStatus {
  return {
    target: 'electron-app', distribution: 'electron', channel: 'nightly',
    currentChannel: 'nightly', targetChannel: 'nightly',
    currentVersion: '1.0.1-nightly.1', currentCommit: 'aaaaaaa', currentPublishedAt: null,
    latestVersion: '1.0.1-nightly.1', latestCommit: 'aaaaaaa', latestCommitTitle: null,
    publishedAt: null, releaseNotes: null, metadataSource: 'oss', errorMessage: null,
    updateAvailable: false, availability: 'up-to-date', stableAvailable: true,
    identity: 'app:nightly:1.0.1-nightly.1:aaaaaaa', websiteUrl: 'https://tx5dr.com',
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <UpdateNotificationProvider>{children}</UpdateNotificationProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.check.mockReset();
});
afterEach(() => { cleanup(); });

describe('update notification badge', () => {
  it('keeps a current nightly quiet while preserving the available stable migration prompt', async () => {
    mocks.check.mockResolvedValue(status());
    const { result } = renderHook(useUpdateNotification, { wrapper });
    await waitFor(() => expect(result.current.status?.stableAvailable).toBe(true));
    expect(result.current.isUnreadUpdateAvailable).toBe(false);
    act(() => result.current.markCurrentAsRead());
    expect(window.localStorage.getItem('tx5dr-stable-migration-dismissed')).toBeNull();
    expect(result.current.status?.stableAvailable).toBe(true);
    expect(result.current.isUnreadUpdateAvailable).toBe(false);
  });

  it('clears a real unread update when viewed and preserves that across refresh and remount', async () => {
    mocks.check.mockResolvedValue(status({ updateAvailable: true, availability: 'available' }));
    const first = renderHook(useUpdateNotification, { wrapper });
    await waitFor(() => expect(first.result.current.isUnreadUpdateAvailable).toBe(true));
    act(() => first.result.current.markCurrentAsRead());
    expect(first.result.current.isUnreadUpdateAvailable).toBe(false);
    await act(async () => { await first.result.current.refresh(); });
    expect(first.result.current.isUnreadUpdateAvailable).toBe(false);
    first.unmount();
    const second = renderHook(useUpdateNotification, { wrapper });
    await waitFor(() => expect(second.result.current.status).not.toBeNull());
    expect(second.result.current.isUnreadUpdateAvailable).toBe(false);
  });

  it('shows a newly available target after the previous target was read', async () => {
    mocks.check.mockResolvedValue(status({ updateAvailable: true }));
    const { result } = renderHook(useUpdateNotification, { wrapper });
    await waitFor(() => expect(result.current.isUnreadUpdateAvailable).toBe(true));
    act(() => result.current.markCurrentAsRead());
    mocks.check.mockResolvedValue(status({ updateAvailable: true, identity: 'app:nightly:new-build' }));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.isUnreadUpdateAvailable).toBe(true);
  });

  it('keeps channel read state independent and does not let migration dismissal hide an update', async () => {
    window.localStorage.setItem('tx5dr-stable-migration-dismissed', '1');
    mocks.check.mockResolvedValue(status({ updateAvailable: true, identity: 'shared-target' }));
    const { result } = renderHook(useUpdateNotification, { wrapper });
    await waitFor(() => expect(result.current.isUnreadUpdateAvailable).toBe(true));
    act(() => result.current.markCurrentAsRead());
    mocks.check.mockResolvedValue(status({ updateAvailable: true, targetChannel: 'release', identity: 'shared-target' }));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.isUnreadUpdateAvailable).toBe(true);
  });
});
