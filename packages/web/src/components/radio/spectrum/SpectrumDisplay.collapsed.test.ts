import { describe, expect, it } from 'vitest';
import {
  clampCollapsedSpectrumFrequency,
  getCollapsedSpectrumPosition,
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
});
