// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@tx5dr/core';

const mocks = vi.hoisted(() => ({
  canSet: true,
  core: { writeRadioMode: false, writeFrequency: true },
  capability: { supported: true, value: 'LSB' as string | null, availability: 'available' },
  setFrequency: vi.fn(),
  setVoiceMode: vi.fn(),
  showError: vi.fn(),
  t: (key: string) => key,
  ability: { can: () => true },
  operators: [],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('../../../store/authStore', () => ({
  useAuth: () => ({ state: { authEnabled: false } }),
  useCan: () => mocks.canSet,
  useHasMinRole: () => true,
  useAbility: () => mocks.ability,
}));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { isConnected: true, radioService: { setVoiceRadioMode: mocks.setVoiceMode } } }),
  useOperators: () => ({ operators: mocks.operators }),
  useProfiles: () => ({ activeProfileId: 'test' }),
  useRadioConnectionState: () => ({ coreCapabilities: mocks.core }),
  useRadioModeState: () => ({ currentRadioFrequency: 14270000, currentRadioMode: 'USB' }),
  useCapabilityDescriptor: () => undefined,
  useCapabilityState: () => mocks.capability,
  useSplitState: () => ({ splitEnabled: false }),
}));
vi.mock('@tx5dr/core', async original => ({
  ...await original<object>(),
  api: {
    getPresetFrequencies: async () => ({ success: true, presets: [] }),
    getLastFrequency: async () => ({ success: true }),
  },
}));
vi.mock('../../../utils/radioFrequencyIntent', () => ({ setRadioFrequencyWithIntent: mocks.setFrequency }));
vi.mock('../../../utils/errorToast', () => ({ showErrorToast: mocks.showError }));
vi.mock('../../settings/FrequencyPresetAddModal', () => ({ FrequencyPresetAddModal: () => null }));
vi.mock('../../radio/frequency/SplitSettingsPopover', () => ({ SplitSettingsPopover: () => null }));
import { VoiceFrequencyControl } from '../VoiceFrequencyControl';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canSet = true;
  mocks.core.writeRadioMode = false;
  mocks.capability = { supported: true, value: 'LSB', availability: 'available' };
  mocks.setFrequency.mockResolvedValue({ success: true, radioMode: 'AM' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<HeroUIProvider disableAnimation><VoiceFrequencyControl /></HeroUIProvider>);

describe('voice mode retry controls', () => {
  it('keeps warning buttons usable and retries with frequency plus mode', async () => {
    mount();
    const button = screen.getByRole('button', { name: 'AM' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'LSB' }).className).toContain('bg-primary');
    fireEvent.click(button);
    await waitFor(() => expect(mocks.setFrequency).toHaveBeenCalledWith(expect.objectContaining({ frequency: 14270000, mode: 'VOICE', radioMode: 'AM' })));
    expect(mocks.setVoiceMode).not.toHaveBeenCalled();
  });

  it('keeps the normal mode-only path when writes are available', async () => {
    mocks.core.writeRadioMode = true;
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'AM' }));
    await waitFor(() => expect(mocks.setVoiceMode).toHaveBeenCalledWith('AM'));
    expect(mocks.setFrequency).not.toHaveBeenCalled();
  });

  it('reports a failed retry and restores selection when write capability recovers', async () => {
    mocks.setFrequency.mockRejectedValue(new ApiError('Request failed', 'Radio unavailable', 503));
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'AM' }));
    await waitFor(() => expect(mocks.showError).toHaveBeenCalled());
    mocks.core.writeRadioMode = true;
    view.rerender(<HeroUIProvider disableAnimation><VoiceFrequencyControl /></HeroUIProvider>);
    expect(screen.getByRole('button', { name: 'USB' }).className).toContain('bg-primary');
    expect(screen.getByRole('button', { name: 'AM' }).className).not.toContain('bg-primary');
  });

  it('does not enable mode writes without permission', () => {
    mocks.canSet = false;
    mount();
    expect((screen.getByRole('button', { name: 'AM' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
