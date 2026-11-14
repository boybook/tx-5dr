// @vitest-environment jsdom
/**
 * Characterization tests for the CW frequency dial: initial frequency source
 * and the CW operating-state intent sent when the dial changes.
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageStub } from './cwTestStorage';

const mocks = vi.hoisted(() => ({
  liveFrequency: null as number | null,
  setFrequency: vi.fn(),
  getLastFrequency: vi.fn(),
  ability: { can: () => true },
  operators: [],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tx5dr/core', async original => ({
  ...await original<object>(),
  api: { getLastFrequency: mocks.getLastFrequency },
}));
vi.mock('../../../store/authStore', () => ({
  useAuth: () => ({ state: { authEnabled: false } }),
  useCan: () => true,
  useAbility: () => mocks.ability,
}));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { isConnected: true, radioService: null } }),
  useOperators: () => ({ operators: mocks.operators }),
  useProfiles: () => ({ activeProfileId: 'profile-1' }),
  useRadioConnectionState: () => ({ coreCapabilities: { writeFrequency: true } }),
  useRadioModeState: () => ({ currentRadioFrequency: mocks.liveFrequency }),
  useSplitState: () => ({ splitEnabled: false, splitTxFrequency: null, splitTxFrequencyWritable: false }),
}));
vi.mock('../../../utils/radioFrequencyIntent', () => ({ setRadioFrequencyWithIntent: mocks.setFrequency }));
vi.mock('../../../utils/errorToast', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../radio/frequency/SplitSettingsPopover', () => ({ SplitSettingsPopover: () => null }));

import { CWFrequencyControl } from '../CWFrequencyControl';

const mount = () => render(<HeroUIProvider disableAnimation><CWFrequencyControl /></HeroUIProvider>);

function displayedFrequency(container: HTMLElement): string {
  return container.textContent?.replace(/[▲▼]/g, '').match(/\d{3}\.\d{3}\.\d{3}/)?.[0] ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  mocks.liveFrequency = null;
  mocks.getLastFrequency.mockResolvedValue({ success: true, lastCWFrequency: { frequency: 7_025_000, mode: 'CW', band: '40m' } });
  mocks.setFrequency.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CWFrequencyControl', () => {
  it('starts from the last CW frequency when the radio reports none', async () => {
    const { container } = mount();
    expect(displayedFrequency(container)).toBe('014.000.000');
    await waitFor(() => expect(displayedFrequency(container)).toBe('007.025.000'));
    expect(mocks.getLastFrequency).toHaveBeenCalled();
  });

  it('prefers the live radio frequency and skips the last-frequency lookup', async () => {
    mocks.liveFrequency = 14_032_500;
    const { container } = mount();
    expect(displayedFrequency(container)).toBe('014.032.500');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.getLastFrequency).not.toHaveBeenCalled();
  });

  it('sends a CW frequency change when a digit is stepped', async () => {
    const { container } = mount();
    await waitFor(() => expect(displayedFrequency(container)).toBe('007.025.000'));
    const digits = container.querySelectorAll('[data-freq-digit]');
    // Digits: MHz x3, kHz x3, Hz x3. Step the 1 kHz digit up.
    fireEvent.mouseEnter(digits[5]);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    await waitFor(() => expect(mocks.setFrequency).toHaveBeenCalledTimes(1));
    expect(mocks.setFrequency).toHaveBeenCalledWith({
      frequency: 7_026_000,
      mode: 'CW',
      band: '40m',
      description: '7.026 MHz',
    });
    expect(displayedFrequency(container)).toBe('007.026.000');
  });
});
