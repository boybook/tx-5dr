// @vitest-environment jsdom
/**
 * RTTY settings modal: number fields commit on Enter and when the modal
 * closes (not only on blur), invalid values snap back, and the signal
 * browser options are saved through the RTTY context.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RttyConfig } from '@tx5dr/contracts';
import { rttyConfig, txStatus } from './rttyTestFixtures';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  config: null as RttyConfig | null,
  updateConfig: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@heroui/toast', () => ({ addToast: mocks.toast }));
vi.mock('../../../store/authStore', () => ({ useCan: () => true }));
vi.mock('../../../hooks/useRtty', () => ({
  useRtty: () => ({ config: mocks.config, txStatus: txStatus(), updateConfig: mocks.updateConfig }),
}));

import { RttySettingsModal } from '../RttySettingsModal';

const ui = (onClose = vi.fn()) => (
  <HeroUIProvider disableAnimation><RttySettingsModal isOpen onClose={onClose} /></HeroUIProvider>
);
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  mocks.config = rttyConfig();
  mocks.updateConfig.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RttySettingsModal', () => {
  it('commits the audio centre on Enter, without waiting for blur', () => {
    render(ui());
    fireEvent.change(field('rtty.settings.center'), { target: { value: '1700' } });
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    fireEvent.keyDown(field('rtty.settings.center'), { key: 'Enter' });
    expect(mocks.updateConfig).toHaveBeenCalledWith({ centerHz: 1700 });
  });

  it('commits a pending max transmission when the modal closes', async () => {
    const onClose = vi.fn();
    render(ui(onClose));
    fireEvent.change(field('rtty.settings.maxTransmit'), { target: { value: '120' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /close/i })); });
    expect(mocks.updateConfig).toHaveBeenCalledWith({ maxTransmitSeconds: 120 });
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape in a number field closes the modal and commits the value', async () => {
    const onClose = vi.fn();
    render(ui(onClose));
    fireEvent.change(field('rtty.settings.center'), { target: { value: '1800' } });
    await act(async () => { fireEvent.keyDown(field('rtty.settings.center'), { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith({ centerHz: 1800 });
  });

  it('rejects out-of-range values and restores the saved one', () => {
    render(ui());
    fireEvent.change(field('rtty.settings.center'), { target: { value: '99' } });
    fireEvent.keyDown(field('rtty.settings.center'), { key: 'Enter' });
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(field('rtty.settings.center').value).toBe('2210');
  });

  it('switches the signal browser', () => {
    render(ui());
    fireEvent.click(screen.getByRole('switch', { name: 'rtty.settings.scanner' }));
    expect(mocks.updateConfig).toHaveBeenCalledWith({ scanner: false });
  });
});
