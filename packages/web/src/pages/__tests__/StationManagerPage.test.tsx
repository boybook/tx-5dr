// @vitest-environment jsdom
/**
 * Station manager page: renders the shell's station list from the bridge state,
 * opens stations through the bridge, and drives the certificate decision of a
 * remote station window.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopStationsState } from '@tx5dr/contracts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key) }),
}));

import { StationManagerPage } from '../StationManagerPage';

const FINGERPRINT = Array(32).fill('AB').join(':');

function baseState(overrides: Partial<DesktopStationsState> = {}): DesktopStationsState {
  return {
    activeStationId: 'embedded',
    openStationIds: ['embedded'],
    embedded: { id: 'embedded', status: 'ready', error: null },
    profiles: [{ id: 'station-b', label: 'Shack B', url: 'http://192.168.1.20:8076', pinnedFingerprint256: null, lastIdentity: { instanceId: 'x', hostVersion: '1.2.3', seenAt: 'now' } }],
    connections: {},
    discovered: [],
    ...overrides,
  };
}

function installBridge(state: DesktopStationsState) {
  const bridge = {
    openManager: vi.fn(async () => undefined),
    subscribe: vi.fn(async (callback: (value: unknown) => void) => {
      callback(state);
      return async () => undefined;
    }),
    connect: vi.fn(async () => undefined),
    trustCertificate: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    probe: vi.fn(),
    save: vi.fn(),
  };
  window.electronAPI = { stations: bridge } as unknown as typeof window.electronAPI;
  return bridge;
}

async function renderPage(search: string) {
  window.history.replaceState(null, '', `/station-manager.html${search}`);
  await act(async () => {
    render(<HeroUIProvider disableAnimation><StationManagerPage /></HeroUIProvider>);
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
});

describe('StationManagerPage', () => {
  it('lists the embedded and remote stations with their state', async () => {
    installBridge(baseState());
    await renderPage('?mode=manage');

    expect(screen.getByText('embeddedLabel')).toBeTruthy();
    expect(screen.getByText('status.ready')).toBeTruthy();
    expect(screen.getByText('Shack B')).toBeTruthy();
    expect(screen.getByText(/192\.168\.1\.20:8076/)).toBeTruthy();
    expect(screen.getByText('badge.open')).toBeTruthy();
  });

  it('opens a remote station through the shell bridge', async () => {
    const bridge = installBridge(baseState());
    await renderPage('?mode=manage');

    const openButtons = screen.getAllByRole('button', { name: 'actions.open' });
    await act(async () => { fireEvent.click(openButtons[openButtons.length - 1]); });

    expect(bridge.connect).toHaveBeenCalledWith('station-b');
  });

  it('shows the empty state when there are no remote stations', async () => {
    installBridge(baseState({ profiles: [] }));
    await renderPage('?mode=manage');

    expect(screen.getByText('empty.title')).toBeTruthy();
  });

  it('asks to trust the presented certificate in a remote station window', async () => {
    const bridge = installBridge(baseState({
      connections: {
        'station-b': {
          stationId: 'station-b',
          phase: 'needs-trust',
          certificate: { fingerprint256: FINGERPRINT, subject: 'CN=shack', issuer: 'CN=shack', validTo: 'Jan 1 2030' },
        },
      },
    }));
    await renderPage('?mode=connect&station=station-b');

    expect(screen.getByText('cert.untrustedTitle')).toBeTruthy();
    expect(screen.getAllByText(FINGERPRINT).length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'actions.trustAndConnect' })); });

    expect(bridge.trustCertificate).toHaveBeenCalledWith('station-b', FINGERPRINT);
  });

  it('requires confirmation before trusting a changed certificate', async () => {
    const bridge = installBridge(baseState({
      connections: {
        'station-b': {
          stationId: 'station-b',
          phase: 'failed',
          error: { kind: 'certificate-changed' },
          changed: { expected: 'OLD', actual: FINGERPRINT },
        },
      },
    }));
    await renderPage('?mode=connect&station=station-b');

    const trust = screen.getByRole('button', { name: 'actions.trustNewAndConnect' });
    expect(trust.hasAttribute('disabled') || trust.getAttribute('data-disabled') === 'true').toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('checkbox')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'actions.trustNewAndConnect' })); });

    expect(bridge.trustCertificate).toHaveBeenCalledWith('station-b', FINGERPRINT);
  });
});
