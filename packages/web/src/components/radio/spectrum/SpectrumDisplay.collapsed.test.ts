import { describe, expect, it } from 'vitest';
import {
  areSpectrumRecoveryStatesEqual,
  buildRadioSdrFrequencyRequest,
  buildRadioSdrTxBandOverlays,
  canShowRadioSdrCenterViewSetting,
  canUseRadioSdrFrequencyRequest,
  clampCollapsedSpectrumFrequency,
  getCollapsedSpectrumPosition,
  getRadioSdrDragFrequencyStepHz,
  isSpectrumEngineNotStarted,
  normalizeRadioSdrCenterViewMode,
  resolveAudioRangeSettingsForModeChange,
  resolveRadioSdrCenterViewContext,
  resolveSpectrumEmptyStatusKey,
  resolveSpectrumRecoveryStateAfterFrame,
  resolveCollapsedSpectrumMarkerFrequencies,
  resolveSpectrumMarkerFrequencies,
  SPECTRUM_RECOVERY_IDLE_STATE,
  shouldPauseSpectrumNoFrameRecovery,
} from './SpectrumDisplay';

describe('spectrum recovery state helpers', () => {
  it('detects equivalent recovery states before scheduling React updates', () => {
    expect(areSpectrumRecoveryStatesEqual(
      { isStale: false, retryCount: 0, exhausted: false },
      { isStale: false, retryCount: 0, exhausted: false },
    )).toBe(true);
    expect(areSpectrumRecoveryStatesEqual(
      { isStale: true, retryCount: 1, exhausted: false },
      { isStale: true, retryCount: 2, exhausted: false },
    )).toBe(false);
  });

  it('resets stale recovery state only once after normal spectrum frames resume', () => {
    let current = { isStale: true, retryCount: 2, exhausted: false };
    let updateCount = 0;

    for (let index = 0; index < 2; index += 1) {
      const next = resolveSpectrumRecoveryStateAfterFrame(current);
      if (!areSpectrumRecoveryStatesEqual(current, next)) {
        updateCount += 1;
        current = next;
      }
    }

    expect(updateCount).toBe(1);
    expect(current).toBe(SPECTRUM_RECOVERY_IDLE_STATE);
    expect(resolveSpectrumRecoveryStateAfterFrame(current)).toBe(current);
  });

  it('uses the latest actual auto range when switching audio spectrum to manual', () => {
    const current = {
      mode: 'auto' as const,
      manual: { minDb: -35, maxDb: 10 },
      auto: {
        updateInterval: 10,
        minPercentile: 15,
        maxPercentile: 99,
        rangeExpansionFactor: 4,
      },
    };

    expect(resolveAudioRangeSettingsForModeChange(current, 'manual', { min: -42.4, max: 9.6 })).toEqual({
      ...current,
      mode: 'manual',
      manual: { minDb: -42, maxDb: 10 },
    });

    expect(resolveAudioRangeSettingsForModeChange(current, 'manual', null)).toEqual({
      ...current,
      mode: 'manual',
    });
  });
});

describe('spectrum no-frame recovery gate', () => {
  it('pauses recovery for Radio SDR while PTT is active', () => {
    expect(shouldPauseSpectrumNoFrameRecovery({
      connectionReady: true,
      selectedKind: 'radio-sdr',
      isTransmitting: true,
      isEngineRunning: true,
      engineState: 'running',
    })).toBe(true);
  });

  it('keeps audio and OpenWebRX recovery active while PTT is active', () => {
    for (const selectedKind of ['audio', 'openwebrx-sdr'] as const) {
      expect(shouldPauseSpectrumNoFrameRecovery({
        connectionReady: true,
        selectedKind,
        isTransmitting: true,
        isEngineRunning: true,
        engineState: 'running',
      })).toBe(false);
    }
  });

  it('pauses recovery when the connected engine is explicitly stopped', () => {
    expect(isSpectrumEngineNotStarted({
      connectionReady: true,
      isEngineRunning: false,
      engineState: 'idle',
    })).toBe(true);

    expect(shouldPauseSpectrumNoFrameRecovery({
      connectionReady: true,
      selectedKind: 'audio',
      isTransmitting: false,
      isEngineRunning: false,
      engineState: 'idle',
    })).toBe(true);
  });

  it('does not treat stale or disconnected engine state as not started', () => {
    expect(isSpectrumEngineNotStarted({
      connectionReady: false,
      isEngineRunning: false,
      engineState: 'idle',
    })).toBe(false);
  });

  it('prioritizes engine and transmit placeholders before recovery copy', () => {
    const staleState = { isStale: true, retryCount: 1, exhausted: false };

    expect(resolveSpectrumEmptyStatusKey({
      engineNotStarted: true,
      radioSdrTransmitPaused: true,
      recoveryState: staleState,
    })).toBe('engineNotStarted');

    expect(resolveSpectrumEmptyStatusKey({
      engineNotStarted: false,
      radioSdrTransmitPaused: true,
      recoveryState: staleState,
    })).toBe('transmittingPaused');

    expect(resolveSpectrumEmptyStatusKey({
      engineNotStarted: false,
      radioSdrTransmitPaused: false,
      recoveryState: { isStale: true, retryCount: 3, exhausted: true },
    })).toBe('noData');

    expect(resolveSpectrumEmptyStatusKey({
      engineNotStarted: false,
      radioSdrTransmitPaused: false,
      recoveryState: staleState,
    })).toBe('retrying');

    expect(resolveSpectrumEmptyStatusKey({
      engineNotStarted: false,
      radioSdrTransmitPaused: false,
      recoveryState: { isStale: false, retryCount: 0, exhausted: false },
    })).toBe('waiting');
  });
});

describe('radio SDR center view settings', () => {
  it('normalizes persisted center view modes', () => {
    expect(normalizeRadioSdrCenterViewMode('full')).toBe('full');
    expect(normalizeRadioSdrCenterViewMode('left')).toBe('left');
    expect(normalizeRadioSdrCenterViewMode('right')).toBe('right');
    expect(normalizeRadioSdrCenterViewMode('wide')).toBe('full');
    expect(normalizeRadioSdrCenterViewMode(null)).toBe('full');
  });

  it('only enables client half-view context for radio SDR absolute center mode', () => {
    expect(resolveRadioSdrCenterViewContext({
      isRadioSdrSelected: true,
      frequencyRangeMode: 'absolute-center',
      centerViewMode: 'right',
      referenceFrequencyHz: 14_074_000,
    })).toEqual({
      centerViewMode: 'right',
      referenceFrequencyHz: 14_074_000,
    });

    expect(resolveRadioSdrCenterViewContext({
      isRadioSdrSelected: true,
      frequencyRangeMode: 'absolute-fixed',
      centerViewMode: 'right',
      referenceFrequencyHz: 14_074_000,
    })).toEqual({
      centerViewMode: 'full',
      referenceFrequencyHz: null,
    });

    expect(resolveRadioSdrCenterViewContext({
      isRadioSdrSelected: false,
      frequencyRangeMode: 'absolute-center',
      centerViewMode: 'left',
      referenceFrequencyHz: 14_074_000,
    })).toEqual({
      centerViewMode: 'full',
      referenceFrequencyHz: null,
    });

    expect(resolveRadioSdrCenterViewContext({
      isRadioSdrSelected: true,
      frequencyRangeMode: 'absolute-center',
      centerViewMode: 'left',
      referenceFrequencyHz: Number.NaN,
    })).toEqual({
      centerViewMode: 'full',
      referenceFrequencyHz: null,
    });
  });

  it('only shows the center view setting where the half-view is supported', () => {
    expect(canShowRadioSdrCenterViewSetting({
      isRadioSdrSelected: true,
      frequencyRangeMode: 'absolute-center',
    })).toBe(true);

    for (const frequencyRangeMode of ['absolute-fixed', 'absolute-windowed', 'baseband'] as const) {
      expect(canShowRadioSdrCenterViewSetting({
        isRadioSdrSelected: true,
        frequencyRangeMode,
      })).toBe(false);
    }

    expect(canShowRadioSdrCenterViewSetting({
      isRadioSdrSelected: false,
      frequencyRangeMode: 'absolute-center',
    })).toBe(false);
  });
});

describe('collapsed spectrum positioning', () => {
  it('clamps digital baseband frequencies to 0-3000 Hz', () => {
    expect(clampCollapsedSpectrumFrequency(-100)).toBe(0);
    expect(clampCollapsedSpectrumFrequency(1500)).toBe(1500);
    expect(clampCollapsedSpectrumFrequency(3100)).toBe(3000);
  });

  it('maps digital baseband frequencies to collapsed bar positions', () => {
    expect(getCollapsedSpectrumPosition(0)).toBe(0);
    expect(getCollapsedSpectrumPosition(1500)).toBe(50);
    expect(getCollapsedSpectrumPosition(3000)).toBe(100);
  });

  it('uses the same marker visibility rules as the expanded spectrum', () => {
    const rxFrequencies = [
      { operatorId: 'op-1', callsign: 'K1ABC', frequency: 1234 },
    ];
    const txFrequencies = [
      { operatorId: 'op-1', callsign: 'N0CALL', frequency: 1500 },
    ];

    expect(resolveSpectrumMarkerFrequencies({
      isOpenWebRXSdrSelected: false,
      isOpenWebRXDetailMode: false,
      showMarkers: true,
      showRxMarkers: false,
      showTxMarkers: true,
      isVoiceMode: false,
      rxFrequencies,
      txFrequencies,
    })).toEqual({
      rxFrequencies: [],
      txFrequencies,
    });
  });

  it('keeps collapsed markers when spectrum session interaction flags are unavailable', () => {
    const rxFrequencies = [
      { operatorId: 'op-1', callsign: 'K1ABC', frequency: 1234 },
    ];
    const txFrequencies = [
      { operatorId: 'op-1', callsign: 'N0CALL', frequency: 1500 },
    ];

    expect(resolveCollapsedSpectrumMarkerFrequencies({
      showMarkers: true,
      isVoiceMode: false,
      rxFrequencies,
      txFrequencies,
    })).toEqual({
      rxFrequencies,
      txFrequencies,
    });

    expect(resolveSpectrumMarkerFrequencies({
      isOpenWebRXSdrSelected: false,
      isOpenWebRXDetailMode: false,
      showMarkers: true,
      showRxMarkers: false,
      showTxMarkers: false,
      isVoiceMode: false,
      rxFrequencies,
      txFrequencies,
    })).toEqual({
      rxFrequencies: [],
      txFrequencies: [],
    });
  });

  it('keeps RX marker identity by operatorId when callsigns match', () => {
    const rxFrequencies = [
      { operatorId: 'op-1', callsign: 'K1ABC', frequency: 1234 },
      { operatorId: 'op-2', callsign: 'K1ABC', frequency: 1300 },
    ];

    const resolved = resolveSpectrumMarkerFrequencies({
      isOpenWebRXSdrSelected: false,
      isOpenWebRXDetailMode: false,
      showMarkers: true,
      showRxMarkers: true,
      showTxMarkers: false,
      isVoiceMode: false,
      rxFrequencies,
      txFrequencies: [],
    });

    expect(resolved.rxFrequencies.map(({ operatorId }) => operatorId)).toEqual(['op-1', 'op-2']);
  });

  it('hides OpenWebRX markers outside detail mode', () => {
    const rxFrequencies = [
      { operatorId: 'op-1', callsign: 'K1ABC', frequency: 1234 },
    ];
    const txFrequencies = [
      { operatorId: 'op-1', callsign: 'N0CALL', frequency: 1500 },
    ];

    expect(resolveSpectrumMarkerFrequencies({
      isOpenWebRXSdrSelected: true,
      isOpenWebRXDetailMode: false,
      showMarkers: true,
      showRxMarkers: true,
      showTxMarkers: true,
      isVoiceMode: false,
      rxFrequencies,
      txFrequencies,
    })).toEqual({
      rxFrequencies: [],
      txFrequencies: [],
    });
  });

  it('does not render digital operator markers in CW mode', () => {
    const rxFrequencies = [
      { operatorId: 'op-1', callsign: 'K1ABC', frequency: 1234 },
    ];
    const txFrequencies = [
      { operatorId: 'op-1', callsign: 'N0CALL', frequency: 1500 },
    ];

    expect(resolveSpectrumMarkerFrequencies({
      isOpenWebRXSdrSelected: false,
      isOpenWebRXDetailMode: false,
      showMarkers: true,
      showRxMarkers: true,
      showTxMarkers: true,
      isVoiceMode: false,
      isCwMode: true,
      rxFrequencies,
      txFrequencies,
    })).toEqual({
      rxFrequencies: [],
      txFrequencies: [],
    });

    expect(resolveCollapsedSpectrumMarkerFrequencies({
      showMarkers: true,
      isVoiceMode: false,
      isCwMode: true,
      rxFrequencies,
      txFrequencies,
    })).toEqual({
      rxFrequencies: [],
      txFrequencies: [],
    });
  });

  it('builds a current RF TX overlay for CW radio SDR only', () => {
    expect(buildRadioSdrTxBandOverlays({
      engineMode: 'cw',
      isRadioSdrSelected: true,
      currentRadioFrequency: 14_050_000,
      voice: null,
      voiceOverlayIsInteractive: false,
    })).toEqual([{
      id: 'cw-current-tx',
      label: 'TX',
      lineFrequency: 14_050_000,
      rangeStartFrequency: 14_050_000,
      rangeEndFrequency: 14_050_000,
      draggable: false,
      variant: 'tx',
    }]);

    expect(buildRadioSdrTxBandOverlays({
      engineMode: 'cw',
      isRadioSdrSelected: false,
      currentRadioFrequency: 14_050_000,
      voice: null,
      voiceOverlayIsInteractive: false,
    })).toEqual([]);
  });

  it('keeps the existing voice SDR occupied-band TX overlay shape', () => {
    expect(buildRadioSdrTxBandOverlays({
      engineMode: 'voice',
      isRadioSdrSelected: true,
      currentRadioFrequency: 14_200_000,
      voice: {
        radioMode: 'USB',
        bandwidthLabel: '2400 Hz',
        occupiedBandwidthHz: 2400,
        offsetModel: 'upper',
      },
      voiceOverlayIsInteractive: true,
    })).toEqual([{
      id: 'voice-current-tx',
      label: 'TX',
      lineFrequency: 14_200_000,
      rangeStartFrequency: 14_200_000,
      rangeEndFrequency: 14_202_400,
      draggable: true,
      variant: 'tx',
    }]);
  });

  it('renders separate RX and TX RF overlays when Split is enabled', () => {
    expect(buildRadioSdrTxBandOverlays({
      engineMode: 'cw',
      isRadioSdrSelected: true,
      currentRadioFrequency: 14_050_000,
      splitEnabled: true,
      splitTxFrequency: 14_052_500,
      voice: null,
      voiceOverlayIsInteractive: false,
    })).toEqual([
      {
        id: 'cw-current-rx',
        label: 'RX',
        lineFrequency: 14_050_000,
        rangeStartFrequency: 14_050_000,
        rangeEndFrequency: 14_050_000,
        draggable: false,
        variant: 'rx',
      },
      {
        id: 'cw-split-tx',
        label: 'TX',
        lineFrequency: 14_052_500,
        rangeStartFrequency: 14_052_500,
        rangeEndFrequency: 14_052_500,
        draggable: false,
        variant: 'tx',
      },
    ]);

    expect(buildRadioSdrTxBandOverlays({
      engineMode: 'voice',
      isRadioSdrSelected: true,
      currentRadioFrequency: 14_200_000,
      splitEnabled: true,
      splitTxFrequency: 14_205_000,
      voice: {
        radioMode: 'USB',
        bandwidthLabel: '2400 Hz',
        occupiedBandwidthHz: 2400,
        offsetModel: 'upper',
      },
      voiceOverlayIsInteractive: true,
    })).toEqual([
      {
        id: 'voice-current-rx',
        label: 'RX',
        lineFrequency: 14_200_000,
        rangeStartFrequency: 14_200_000,
        rangeEndFrequency: 14_202_400,
        draggable: true,
        variant: 'rx',
      },
      {
        id: 'voice-split-tx',
        label: 'TX',
        lineFrequency: 14_205_000,
        rangeStartFrequency: 14_205_000,
        rangeEndFrequency: 14_207_400,
        draggable: false,
        variant: 'tx',
      },
    ]);
  });

  it('does not synthesize a Split TX overlay before TX frequency metadata arrives', () => {
    expect(buildRadioSdrTxBandOverlays({
      engineMode: 'cw',
      isRadioSdrSelected: true,
      currentRadioFrequency: 14_050_000,
      splitEnabled: true,
      splitTxFrequency: null,
      voice: null,
      voiceOverlayIsInteractive: false,
    })).toEqual([{
      id: 'cw-current-rx',
      label: 'RX',
      lineFrequency: 14_050_000,
      rangeStartFrequency: 14_050_000,
      rangeEndFrequency: 14_050_000,
      draggable: false,
      variant: 'rx',
    }]);

    expect(buildRadioSdrTxBandOverlays({
      engineMode: 'voice',
      isRadioSdrSelected: true,
      currentRadioFrequency: 14_200_000,
      splitEnabled: true,
      splitTxFrequency: null,
      voice: {
        radioMode: 'USB',
        bandwidthLabel: '2400 Hz',
        occupiedBandwidthHz: 2400,
        offsetModel: 'upper',
      },
      voiceOverlayIsInteractive: true,
    })).toEqual([{
      id: 'voice-current-rx',
      label: 'RX',
      lineFrequency: 14_200_000,
      rangeStartFrequency: 14_200_000,
      rangeEndFrequency: 14_202_400,
      draggable: true,
      variant: 'rx',
    }]);
  });

  it('builds CW SDR frequency requests with CW mode and 10 Hz snapping', () => {
    expect(buildRadioSdrFrequencyRequest({
      engineMode: 'cw',
      frequency: 14_050_004,
      stepHz: 10,
    })).toEqual({
      frequency: 14_050_000,
      mode: 'CW',
      band: '20m',
      description: '14.050 MHz',
    });
  });

  it('keeps voice SDR frequency requests in VOICE mode', () => {
    expect(buildRadioSdrFrequencyRequest({
      engineMode: 'voice',
      frequency: 14_200_499,
      stepHz: 1000,
    })).toEqual({
      frequency: 14_200_000,
      mode: 'VOICE',
      band: 'Custom',
      description: '14.200 MHz',
    });
  });

  it('uses radio SDR drag steps for voice and CW tuning', () => {
    expect(getRadioSdrDragFrequencyStepHz('voice')).toBe(1000);
    expect(getRadioSdrDragFrequencyStepHz('cw')).toBe(10);
    expect(getRadioSdrDragFrequencyStepHz('digital')).toBeNull();
  });

  it('checks SDR frequency gesture requests against target frequency authorization', () => {
    const request = buildRadioSdrFrequencyRequest({
      engineMode: 'voice',
      frequency: 14_270_499,
      stepHz: 1000,
    });
    const canWrite20mOnly = (frequency: number) => frequency >= 14_000_000 && frequency <= 14_350_000;

    expect(canUseRadioSdrFrequencyRequest(request, canWrite20mOnly)).toBe(true);
    expect(canUseRadioSdrFrequencyRequest({
      ...request!,
      frequency: 14_500_000,
    }, canWrite20mOnly)).toBe(false);
    expect(canUseRadioSdrFrequencyRequest(null, canWrite20mOnly)).toBe(false);
  });
});
