// @vitest-environment jsdom
/**
 * Top-left station tag: inside the desktop shell it always identifies the
 * window's station and offers the station manager; in a browser it keeps
 * appearing only for a configured station profile.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stationInfo: null as null | Record<string, unknown> }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../store/radioStore', () => ({ useStationInfo: () => mocks.stationInfo }));
vi.mock('../../../store/authStore', () => ({ useHasMinRole: () => false }));
vi.mock('@tx5dr/core', () => ({ api: { getStationIdentity: vi.fn(async () => ({ hostVersion: '1.2.3' })) } }));

import { StationInfoPopover } from '../StationInfoPopover';

function installShell(kind: 'embedded' | 'remote') {
  const stations = {
    openManager: vi.fn(async () => undefined),
    getCurrent: vi.fn(async () => (kind === 'remote'
      ? { stationId: 's', kind: 'remote', label: 'Shack B', url: 'http://192.168.1.20:8076' }
      : { stationId: 'embedded', kind: 'embedded', label: null, url: null })),
  };
  window.electronAPI = {
    bridge: { version: 1, kind, capabilities: ['stations'] },
    stations,
  } as unknown as typeof window.electronAPI;
  return stations;
}

beforeEach(() => {
  mocks.stationInfo = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
});

describe('StationInfoPopover', () => {
  it('stays hidden in a browser until the station has a profile', () => {
    render(<HeroUIProvider><StationInfoPopover /></HeroUIProvider>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows only the station profile in a browser, without desktop entries', async () => {
    mocks.stationInfo = { callsign: 'BG7XXX', qth: { grid: 'PM01' } };
    await act(async () => { render(<HeroUIProvider disableAnimation><StationInfoPopover /></HeroUIProvider>); });

    const trigger = screen.getByRole('button', { name: 'BG7XXX' });
    expect(trigger.textContent).toBe('BG7XXXPM01');
    await act(async () => { fireEvent.click(trigger); });

    expect(await screen.findByText('1.2.3')).toBeTruthy();
    expect(screen.queryByText('tag.connection')).toBeNull();
    expect(screen.queryByText('tag.address')).toBeNull();
    expect(screen.queryByText('tag.embedded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'tag.manage' })).toBeNull();
  });

  it('does not fall back to the page address in a browser when only a grid is set', async () => {
    mocks.stationInfo = { qth: { grid: 'PM01' } };
    await act(async () => { render(<HeroUIProvider disableAnimation><StationInfoPopover /></HeroUIProvider>); });

    expect(screen.getByRole('button', { name: 'PM01' }).textContent).toBe('PM01');
  });

  it('marks a remote window as remote before its details arrive', async () => {
    window.electronAPI = {
      bridge: { version: 1, kind: 'remote', capabilities: ['stations'] },
      stations: { openManager: vi.fn(), getCurrent: () => new Promise(() => undefined) },
    } as unknown as typeof window.electronAPI;
    await act(async () => { render(<HeroUIProvider disableAnimation><StationInfoPopover /></HeroUIProvider>); });

    expect(screen.getByRole('button', { name: 'tag.remote: tag.remote' })).toBeTruthy();
  });

  it('names the remote station of a desktop window without a station profile', async () => {
    installShell('remote');
    await act(async () => { render(<HeroUIProvider disableAnimation><StationInfoPopover /></HeroUIProvider>); });

    expect(screen.getByRole('button', { name: 'tag.remote: Shack B' })).toBeTruthy();
  });

  it('prefers the callsign and opens the station manager from the popover', async () => {
    mocks.stationInfo = { callsign: 'BG7XXX', qth: { grid: 'PM01' } };
    const stations = installShell('embedded');
    await act(async () => { render(<HeroUIProvider disableAnimation><StationInfoPopover /></HeroUIProvider>); });

    const trigger = screen.getByRole('button', { name: 'tag.embedded: BG7XXX' });
    expect(trigger.textContent).toContain('PM01');
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'tag.manage' })); });

    expect(stations.openManager).toHaveBeenCalled();
  });
});
