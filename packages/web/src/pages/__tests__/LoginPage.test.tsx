// @vitest-environment jsdom
/**
 * Full-screen login page: shows the station profile as plain text and, inside
 * the desktop shell, names the window's station with a way to the station manager.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tx5dr/core', () => ({
  api: { getStationInfo: vi.fn(async () => ({ success: true, data: { callsign: 'BG7XXX', qth: { grid: 'PM01' } } })) },
}));
vi.mock('../../components/auth/AuthLoginForm', () => ({ AuthLoginForm: () => <form aria-label="login-form" /> }));

import { LoginPage } from '../LoginPage';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
});

describe('LoginPage', () => {
  it('shows the station profile inline without a desktop station footer in a browser', async () => {
    await act(async () => { render(<HeroUIProvider disableAnimation><LoginPage /></HeroUIProvider>); });

    expect(screen.getByText('BG7XXX')).toBeTruthy();
    expect(screen.getByText('PM01')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'login-form' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'tag.manage' })).toBeNull();
  });

  it('names the remote station and opens the station manager in the desktop shell', async () => {
    const stations = {
      openManager: vi.fn(async () => undefined),
      getCurrent: vi.fn(async () => ({ stationId: 's', kind: 'remote', label: 'Shack B', url: 'http://192.168.1.20:8076' })),
    };
    window.electronAPI = { bridge: { version: 1, kind: 'remote', capabilities: ['stations'] }, stations } as unknown as typeof window.electronAPI;
    await act(async () => { render(<HeroUIProvider disableAnimation><LoginPage /></HeroUIProvider>); });

    expect(screen.getByText('Shack B')).toBeTruthy();
    expect(screen.getByText('192.168.1.20:8076')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'tag.manage' })); });
    expect(stations.openManager).toHaveBeenCalled();
  });
});
