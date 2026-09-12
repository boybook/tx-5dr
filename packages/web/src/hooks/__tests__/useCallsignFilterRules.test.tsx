// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallsignFilterRules } from '../useCallsignFilterRules';

const mocks = vi.hoisted(() => ({ getOperatorState: vi.fn() }));
vi.mock('../../utils/pluginApi', () => ({ pluginApi: { getOperatorState: mocks.getOperatorState } }));
vi.mock('../usePluginSnapshot', () => ({ usePluginSnapshot: () => ({ generation: 1, plugins: [{ name: 'callsign-filter', enabled: true }] }) }));
vi.mock('../../store/radioStore', () => ({ useRadioModeState: () => ({ currentRadioFrequency: 14074000 }) }));
afterEach(cleanup);

it('does not apply a delayed filter response from a previously selected operator', async () => {
  let finishOld!: (value: unknown) => void;
  const old = new Promise(resolve => { finishOld = resolve; });
  mocks.getOperatorState.mockReturnValueOnce(old).mockResolvedValueOnce({ operatorSettings: {
    'callsign-filter': { filterRules: ['K1ABC'], filterScope: 'auto-reply-and-display' },
  } });
  const { result, rerender } = renderHook(({ operator }) => useCallsignFilterRules(operator), { initialProps: { operator: 'old' } });
  rerender({ operator: 'new' });
  await act(async () => {});
  expect(result.current.rules.map(rule => rule.raw)).toEqual(['K1ABC']);
  await act(async () => finishOld({ operatorSettings: {
    'callsign-filter': { filterRules: ['JA1AAA'], filterScope: 'auto-reply-and-display' },
  } }));
  expect(result.current.rules.map(rule => rule.raw)).toEqual(['K1ABC']);
});
