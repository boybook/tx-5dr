import { describe, expect, it } from 'vitest';
import {
  buildRadioSdrFrequencyRequest,
  buildRadioSdrTxBandOverlays,
  canUseRadioSdrFrequencyRequest,
  clampCollapsedSpectrumFrequency,
  getCollapsedSpectrumPosition,
  getRadioSdrDragFrequencyStepHz,
  resolveCollapsedSpectrumMarkerFrequencies,
  resolveSpectrumMarkerFrequencies,
} from './SpectrumDisplay';

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
      radioMode: 'CW',
      band: '20m',
      description: '14.050 MHz',
    });
  });

  it('keeps voice SDR frequency requests in VOICE mode', () => {
    expect(buildRadioSdrFrequencyRequest({
      engineMode: 'voice',
      frequency: 14_200_499,
      stepHz: 1000,
      voiceRadioMode: 'USB',
      currentRadioMode: 'LSB',
    })).toEqual({
      frequency: 14_200_000,
      mode: 'VOICE',
      band: 'Custom',
      description: '14.200 MHz',
      radioMode: 'USB',
      repeaterShift: 'none',
      toneMode: 'none',
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
      voiceRadioMode: 'USB',
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
