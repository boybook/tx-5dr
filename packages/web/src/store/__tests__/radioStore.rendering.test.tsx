// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadioProvider } from '../radio/provider';
import { useCWState, useCurrentOperatorId, useProfiles, usePTTState, useRadioActions, useRadioMeters, useRadioModeState, useSpectrum, useSplitState } from '../radio/hooks';
import { initialRadioState, radioReducer } from '../radio/reducers';
import type { OperatorStatus } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';

vi.mock('../authStore', () => ({ useAuth: () => ({ state: { initialized: true, sessionResolved: true, authEnabled: true, jwt: null, role: 'viewer' } }) }));
vi.mock('../../radio-capability/CapabilityEnvironment', () => ({ CapabilityEnvironmentProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../services/radioService', () => ({
  getOrCreateRadioService: () => ({
    replaceProviderEventHandlers: () => () => {},
    getConnectionStatus: () => ({ isConnected: false, isConnecting: false }),
    connect: () => Promise.resolve(),
    wsClientInstance: { onWSEvent: () => {}, offWSEvent: () => {} },
  }),
}));

afterEach(cleanup);

describe('radio render boundaries', () => {
  it('updates meter consumers without rendering mode, spectrum, split, CW, PTT or action consumers', () => {
    const counts = { meter: 0, mode: 0, spectrum: 0, split: 0, cw: 0, ptt: 0, actions: 0 };
    let actions!: ReturnType<typeof useRadioActions>;
    let ptt!: ReturnType<typeof usePTTState>;
    let meters!: ReturnType<typeof useRadioMeters>;
    function Actions() { actions = useRadioActions(); counts.actions++; return null; }
    function Meters() { meters = useRadioMeters(); counts.meter++; return null; }
    function Mode() { useRadioModeState(); counts.mode++; return null; }
    function Spectrum() { useSpectrum(); counts.spectrum++; return null; }
    function Split() { useSplitState(); counts.split++; return null; }
    function CW() { useCWState(); counts.cw++; return null; }
    function PTT() { ptt = usePTTState(); counts.ptt++; return null; }
    const view = render(<RadioProvider><Actions /><Meters /><Mode /><Spectrum /><Split /><CW /><PTT /></RadioProvider>);
    const before = { ...counts };
    const dispatch = actions.dispatch;
    for (let value = 1; value <= 3; value++) {
      act(() => dispatch({ type: 'meterData', payload: { level: null, swr: null, alc: null, power: { raw: value, watts: value, maxWatts: 100, percent: value } } }));
    }
    expect(counts).toEqual({ ...before, meter: before.meter + 3 });
    expect(meters.meterData?.power?.watts).toBe(3);
    expect(actions.dispatch).toBe(dispatch);
    act(() => dispatch({ type: 'pttStatusChanged', payload: { isTransmitting: true, operatorIds: ['operator'] } }));
    expect(ptt.pttStatus.isTransmitting).toBe(true);
    expect(counts.ptt).toBe(before.ptt + 1);
    expect(counts.spectrum).toBe(before.spectrum);
    view.unmount();
  });

  it('preserves the state and operator array on duplicate or unknown operator updates', () => {
    const operator: OperatorStatus = { id: 'operator', isActive: true, isTransmitting: false, context: { myCall: 'TEST', myGrid: 'AA00', targetCall: '' }, strategy: { name: 'standard', state: 'idle', availableSlots: [] } };
    const state = { ...initialRadioState, operators: [operator] };
    expect(radioReducer(state, { type: 'operatorStatusUpdate', payload: structuredClone(operator) })).toBe(state);
    expect(radioReducer(state, { type: 'operatorStatusUpdate', payload: { ...operator, id: 'missing' } })).toBe(state);
    const changed = radioReducer(state, { type: 'operatorStatusUpdate', payload: { ...operator, isActive: false } });
    expect(changed.operators[0].isActive).toBe(false);
    expect(changed.operators).not.toBe(state.operators);
    expect(operator.isActive).toBe(true);
  });

  it('keeps mode identity on status heartbeats while accepting changed timing parameters', () => {
    const state = { ...initialRadioState, currentMode: MODES.FT8 };
    const next = radioReducer(state, { type: 'systemStatus', payload: {
      currentMode: structuredClone(MODES.FT8), currentTime: 123, nextSlotIn: 1000,
      isRunning: true, isDecoding: true, audioStarted: true, engineMode: 'digital',
    } });
    expect(next.currentMode).toBe(state.currentMode);
    expect(next.systemStatus?.currentTime).toBe(123);
    const changedMode = { ...MODES.FT8, windowTiming: [-300] };
    expect(radioReducer(next, { type: 'modeChanged', payload: changedMode }).currentMode).toBe(changedMode);
  });

  it('keeps operator selection separate from runtime updates and preserves configured-profile visibility', () => {
    let actions!: ReturnType<typeof useRadioActions>;
    let selection!: ReturnType<typeof useCurrentOperatorId>;
    let profiles!: ReturnType<typeof useProfiles>;
    let selectionRenders = 0;
    function Actions() { actions = useRadioActions(); return null; }
    function Selection() { selection = useCurrentOperatorId(); selectionRenders++; return null; }
    function Profiles() { profiles = useProfiles(); return null; }
    render(<RadioProvider><Actions /><Selection /><Profiles /></RadioProvider>);
    const operator: OperatorStatus = { id: 'operator', isActive: true, isTransmitting: false, context: { myCall: 'TEST', myGrid: 'AA00', targetCall: '' }, strategy: { name: 'standard', state: 'idle', availableSlots: [] } };
    act(() => actions.dispatch({ type: 'operatorsList', payload: [operator] }));
    expect(selection.currentOperatorId).toBe('operator');
    const before = selectionRenders;
    act(() => actions.dispatch({ type: 'operatorStatusUpdate', payload: { ...operator, context: { ...operator.context, targetCall: 'K1ABC' } } }));
    expect(selectionRenders).toBe(before);
    act(() => actions.dispatch({ type: 'setProfiles', payload: { profiles: [], activeProfileId: null, hasConfiguredProfiles: true } }));
    expect(profiles.hasConfiguredProfiles).toBe(true);
    expect(profiles.profilesLoaded).toBe(true);
  });
});
