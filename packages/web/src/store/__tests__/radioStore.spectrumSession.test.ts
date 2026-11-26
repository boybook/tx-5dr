import { describe, expect, it } from 'vitest';
import type { SpectrumSessionState } from '@tx5dr/contracts';
import { initialRadioState, radioReducer } from '../radioStore';

function createSessionState(overrides: Partial<SpectrumSessionState> = {}): SpectrumSessionState {
  return {
    kind: 'audio',
    sourceMode: 'baseband',
    currentRadioFrequency: 14074000,
    voice: { radioMode: 'USB', bandwidthLabel: '15000 Hz', occupiedBandwidthHz: 15000, offsetModel: 'upper' },
    ...overrides,
  } as SpectrumSessionState;
}

describe('radioReducer spectrum session state', () => {
  it('keeps the state reference when an identical session state is re-sent', () => {
    const first = radioReducer(initialRadioState, { type: 'setSpectrumSessionState', payload: createSessionState() });

    const repeated = radioReducer(first, { type: 'setSpectrumSessionState', payload: createSessionState() });

    expect(repeated).toBe(first);
  });

  it('applies a changed session state', () => {
    const first = radioReducer(initialRadioState, { type: 'setSpectrumSessionState', payload: createSessionState() });
    const payload = createSessionState({ currentRadioFrequency: 7074000 });

    const next = radioReducer(first, { type: 'setSpectrumSessionState', payload });

    expect(next.spectrumSessionState).toBe(payload);
    expect(next.currentRadioFrequency).toBe(7074000);
  });

  it('still reapplies the session frequency after another source changed it', () => {
    const first = radioReducer(initialRadioState, { type: 'setSpectrumSessionState', payload: createSessionState() });
    const moved = { ...first, currentRadioFrequency: 7074000 };

    const next = radioReducer(moved, { type: 'setSpectrumSessionState', payload: createSessionState() });

    expect(next.spectrumSessionState).toBe(first.spectrumSessionState);
    expect(next.currentRadioFrequency).toBe(14074000);
  });
});
