import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpectrumCapabilities } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { createSpectrumNegotiator } from '../radio/spectrumNegotiation';
import { initialRadioState, radioReducer, type RadioState } from '../radioStore';
import { setSpectrumSubscriptionPaused } from '../../utils/spectrumSubscriptionPause';

function createCapabilities(options: {
  audioAvailable?: boolean;
  radioSupported?: boolean;
  radioAvailable?: boolean;
  openWebRXSupported?: boolean;
  openWebRXAvailable?: boolean;
  profileId?: string | null;
} = {}): SpectrumCapabilities {
  const {
    audioAvailable = true,
    radioSupported = true,
    radioAvailable = false,
    openWebRXSupported = false,
    openWebRXAvailable = false,
    profileId = null,
  } = options;

  return {
    profileId,
    defaultKind: 'audio',
    sources: [
      {
        kind: 'radio-sdr',
        supported: radioSupported,
        available: radioAvailable,
        defaultSelected: false,
        displayBinCount: 1024,
        sourceBinCount: null,
        supportsWaterfall: true,
        frequencyRangeMode: 'absolute',
      },
      {
        kind: 'openwebrx-sdr',
        supported: openWebRXSupported,
        available: openWebRXAvailable,
        defaultSelected: false,
        displayBinCount: 1024,
        sourceBinCount: null,
        supportsWaterfall: true,
        frequencyRangeMode: 'absolute',
      },
      {
        kind: 'audio',
        supported: true,
        available: audioAvailable,
        defaultSelected: true,
        displayBinCount: 1024,
        sourceBinCount: 1024,
        supportsWaterfall: true,
        frequencyRangeMode: 'baseband',
      },
    ],
  };
}

function createHarness() {
  const radioService = {
    subscribeSpectrum: vi.fn(),
    invokeSpectrumControl: vi.fn(),
  };
  const radioStateRef: { current: RadioState } = {
    current: {
      ...initialRadioState,
      currentMode: MODES.VOICE,
      engineMode: 'voice' as const,
    },
  };
  const capabilitiesRef = { current: null as SpectrumCapabilities | null };
  const activeProfileIdRef = { current: null as string | null };
  const spectrumAutoPriorityPendingRef = { current: true };
  const pendingDefaultOpenWebRXDetailProfileRef = { current: null as string | null };

  const radioDispatch = vi.fn((action: Parameters<typeof radioReducer>[1]) => {
    radioStateRef.current = radioReducer(radioStateRef.current, action);
    if (action.type === 'setSpectrumCapabilities') {
      capabilitiesRef.current = action.payload;
    }
  });

  const negotiator = createSpectrumNegotiator({
    radioDispatch,
    radioService: radioService as never,
    capabilitiesRef,
    radioStateRef,
    activeProfileIdRef,
    spectrumAutoPriorityPendingRef,
    pendingDefaultOpenWebRXDetailProfileRef,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });

  return {
    negotiator,
    radioService,
    radioStateRef,
    capabilitiesRef,
    spectrumAutoPriorityPendingRef,
  };
}

describe('spectrum negotiation', () => {
  beforeEach(() => {
    setSpectrumSubscriptionPaused(false);
  });

  it('auto-upgrades from audio to radio SDR when radio SDR becomes available later', () => {
    const harness = createHarness();

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: false,
    }));

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('audio');
    expect(harness.spectrumAutoPriorityPendingRef.current).toBe(true);

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: true,
    }));

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('radio-sdr');
    expect(harness.radioStateRef.current.subscribedSpectrumKind).toBe('radio-sdr');
    expect(harness.spectrumAutoPriorityPendingRef.current).toBe(false);
    expect(harness.radioService.subscribeSpectrum).toHaveBeenLastCalledWith('radio-sdr');
  });

  it('continues auto-upgrading from radio SDR to OpenWebRX when OpenWebRX becomes available later', () => {
    const harness = createHarness();

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: true,
      openWebRXSupported: true,
      openWebRXAvailable: false,
    }));

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('radio-sdr');
    expect(harness.spectrumAutoPriorityPendingRef.current).toBe(true);

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: true,
      openWebRXSupported: true,
      openWebRXAvailable: true,
    }));

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('openwebrx-sdr');
    expect(harness.radioStateRef.current.subscribedSpectrumKind).toBe('openwebrx-sdr');
    expect(harness.spectrumAutoPriorityPendingRef.current).toBe(false);
    expect(harness.radioService.subscribeSpectrum).toHaveBeenLastCalledWith('openwebrx-sdr');
  });

  it('does not override a manual audio selection after higher-priority sources recover', () => {
    const harness = createHarness();

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: false,
    }));

    harness.spectrumAutoPriorityPendingRef.current = false;
    harness.radioStateRef.current = radioReducer(harness.radioStateRef.current, {
      type: 'setSelectedSpectrumKind',
      payload: 'audio',
    });
    harness.radioStateRef.current = radioReducer(harness.radioStateRef.current, {
      type: 'setSubscribedSpectrumKind',
      payload: 'audio',
    });

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: true,
    }));

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('audio');
    expect(harness.radioStateRef.current.subscribedSpectrumKind).toBe('audio');
    expect(harness.radioService.subscribeSpectrum).toHaveBeenLastCalledWith('audio');
  });

  it('re-enables auto priority after mode-driven reset', () => {
    const harness = createHarness();
    const initialCapabilities = createCapabilities({
      radioSupported: true,
      radioAvailable: false,
    });

    harness.negotiator.applySpectrumSelection(initialCapabilities);
    harness.capabilitiesRef.current = initialCapabilities;
    harness.spectrumAutoPriorityPendingRef.current = false;

    harness.radioStateRef.current = radioReducer(harness.radioStateRef.current, {
      type: 'setSelectedSpectrumKind',
      payload: 'audio',
    });
    harness.radioStateRef.current = radioReducer(harness.radioStateRef.current, {
      type: 'setSubscribedSpectrumKind',
      payload: 'audio',
    });

    harness.negotiator.applyModeDrivenSpectrumNegotiation();
    expect(harness.spectrumAutoPriorityPendingRef.current).toBe(true);

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: true,
    }));

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('radio-sdr');
    expect(harness.radioService.subscribeSpectrum).toHaveBeenLastCalledWith('radio-sdr');
  });

  it('keeps selection but skips subscribing while spectrum is collapsed', () => {
    const harness = createHarness();
    setSpectrumSubscriptionPaused(true);

    harness.negotiator.applySpectrumSelection(createCapabilities({
      radioSupported: true,
      radioAvailable: true,
    }));

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('radio-sdr');
    expect(harness.radioStateRef.current.subscribedSpectrumKind).toBeNull();
    expect(harness.radioService.subscribeSpectrum).not.toHaveBeenCalled();
  });

  it('does not resubscribe during mode-driven negotiation while spectrum is collapsed', () => {
    const harness = createHarness();
    const capabilities = createCapabilities({
      radioSupported: true,
      radioAvailable: true,
    });
    harness.capabilitiesRef.current = capabilities;
    setSpectrumSubscriptionPaused(true);

    harness.negotiator.applyModeDrivenSpectrumNegotiation();

    expect(harness.radioStateRef.current.selectedSpectrumKind).toBe('radio-sdr');
    expect(harness.radioStateRef.current.subscribedSpectrumKind).toBeNull();
    expect(harness.radioService.subscribeSpectrum).not.toHaveBeenCalled();
  });
});
