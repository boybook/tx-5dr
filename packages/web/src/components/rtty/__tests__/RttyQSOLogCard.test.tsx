// @vitest-environment jsdom
/**
 * RTTY QSO log card: logs mode RTTY at the mark RF frequency derived from the
 * dial frequency and the RTTY configuration.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QSORecord, RttyConfig, RttyTxStatus } from '@tx5dr/contracts';
import { createStorageStub } from '../../cw/__tests__/cwTestStorage';
import { rttyConfig, txStatus } from './rttyTestFixtures';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  config: null as RttyConfig | null,
  tx: null as RttyTxStatus | null,
  service: { wsClientInstance: { send: vi.fn(), onWSEvent: vi.fn(), offWSEvent: vi.fn() } },
  api: { createQSO: vi.fn(), updateQSO: vi.fn(), deleteQSO: vi.fn(), getLogBookQSOs: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@heroui/toast', () => ({ addToast: mocks.toast }));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock('../../../utils/windowManager', () => ({ openLogbookWindow: vi.fn() }));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { isConnected: true, radioService: mocks.service } }),
  useRadioModeState: () => ({ engineMode: 'rtty', currentRadioFrequency: 14_085_000, currentRadioMode: 'PKTLSB' }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'op1', setCurrentOperatorId: vi.fn() }),
  useOperators: () => ({ operators: [{ id: 'op1', context: { myCall: 'K1ABC', myGrid: 'FN42' } }] }),
}));
vi.mock('../../../hooks/useRtty', () => ({ useRtty: () => ({ txStatus: mocks.tx, config: mocks.config }) }));

import { RttyQSOLogCard } from '../RttyQSOLogCard';
import { rttyQsoDraftStore } from '../../../store/rttyQsoDraftStore';
import { logRttyQso, registerRttyEsmStep } from '../rttyQsoActions';
import { consumeLocallyLoggedQso } from '../../../utils/localQsoLog';

const ui = () => <HeroUIProvider disableAnimation><RttyQSOLogCard /></HeroUIProvider>;

async function logQso() {
  render(ui());
  fireEvent.change(screen.getByLabelText('radio:rtty.qso.callsign'), { target: { value: 'ja1xyz' } });
  fireEvent.click(screen.getByRole('button', { name: 'radio:rtty.qso.logQSO' }));
  await waitFor(() => expect(mocks.api.createQSO).toHaveBeenCalledTimes(1));
  return mocks.api.createQSO.mock.calls[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  mocks.config = rttyConfig();
  mocks.tx = txStatus();
  mocks.api.getLogBookQSOs.mockResolvedValue({ data: [] });
  mocks.api.createQSO.mockResolvedValue({ success: true });
  rttyQsoDraftStore.setHisCallsign('');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RttyQSOLogCard', () => {
  it('logs an RTTY QSO at the LSB mark RF frequency (dial minus the low audio tone)', async () => {
    const [logbookId, body] = await logQso();
    expect(logbookId).toBe('K1ABC');
    // LSB, centre 2210 Hz, shift 170 Hz: mark audio 2125 Hz.
    expect(body).toMatchObject({ callsign: 'JA1XYZ', mode: 'RTTY', frequency: 14_082_875, reportSent: '599', reportReceived: '599' });
    expect(screen.getByText('14.083 MHz')).toBeTruthy();
  });

  it('uses dial plus the high audio tone on USB', async () => {
    mocks.config = rttyConfig({ sideband: 'usb' });
    const [, body] = await logQso();
    expect(body.frequency).toBe(14_087_295);
  });

  it('falls back to the dial frequency before the RTTY configuration is loaded', async () => {
    mocks.config = null;
    const [, body] = await logQso();
    expect(body.frequency).toBe(14_085_000);
  });

  it('suppresses the server echo toast for the QSO this client logs', async () => {
    await logQso();
    expect(consumeLocallyLoggedQso('JA1XYZ')).toBe(true);
  });
});

const callsignInput = () => screen.getByLabelText('radio:rtty.qso.callsign') as HTMLInputElement;
const timeText = (key: string) => screen.getByText(new RegExp(`radio:rtty.qso.${key}`)).textContent ?? '';

describe('RttyQSOLogCard QSO times', () => {
  it('starts when the callsign is entered and ignores transmissions while the form is empty', async () => {
    const view = render(ui());
    // A transmission (e.g. CQ) with an empty form writes no times.
    mocks.tx = txStatus({ active: true, phase: 'on_air' });
    view.rerender(ui());
    mocks.tx = txStatus();
    view.rerender(ui());
    expect(timeText('startTime')).toContain('--:--:--');
    expect(timeText('endTime')).toContain('--:--:--');

    fireEvent.change(callsignInput(), { target: { value: 'ja1xyz' } });
    expect(timeText('startTime')).not.toContain('--:--:--');
    expect(timeText('endTime')).toContain('--:--:--');

    mocks.tx = txStatus({ active: true, phase: 'on_air' });
    view.rerender(ui());
    mocks.tx = txStatus();
    view.rerender(ui());
    expect(timeText('endTime')).not.toContain('--:--:--');

    fireEvent.click(screen.getByRole('button', { name: 'radio:rtty.qso.logQSO' }));
    await waitFor(() => expect(mocks.api.createQSO).toHaveBeenCalledTimes(1));
    const [, body] = mocks.api.createQSO.mock.calls[0];
    expect(body.endTime).toBeGreaterThanOrEqual(body.startTime);

    // The logged form is empty again; a transmission still running must not refill its times.
    await waitFor(() => expect(callsignInput().value).toBe(''));
    mocks.tx = txStatus({ active: true, phase: 'on_air' });
    view.rerender(ui());
    mocks.tx = txStatus();
    view.rerender(ui());
    expect(timeText('startTime')).toContain('--:--:--');
    expect(timeText('endTime')).toContain('--:--:--');
  });
});

describe('RttyQSOLogCard keyboard flow and dupe check', () => {
  it('Enter in the callsign field runs the ESM step (physical keyboard only); the registered log action logs the form', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query === '(pointer: fine)', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    const step = vi.fn();
    const unregister = registerRttyEsmStep(step);
    render(ui());
    fireEvent.change(callsignInput(), { target: { value: 'ja1xyz' } });
    fireEvent.keyDown(callsignInput(), { key: 'Enter' });
    expect(step).toHaveBeenCalledTimes(1);
    // Holding Enter (auto-repeat) does not run the next step.
    fireEvent.keyDown(callsignInput(), { key: 'Enter', repeat: true });
    expect(step).toHaveBeenCalledTimes(1);
    unregister();

    let logged = false;
    await act(async () => { logged = await logRttyQso(); });
    expect(logged).toBe(true);
    expect(mocks.api.createQSO).toHaveBeenCalledTimes(1);
  });

  it('warns about a dupe (same band and mode) but still allows logging', async () => {
    const record = { id: 'q1', callsign: 'DL1DUP', mode: 'RTTY', frequency: 14_083_000, startTime: 1 } as QSORecord;
    mocks.api.getLogBookQSOs.mockResolvedValue({ data: [record] });
    render(ui());
    fireEvent.change(callsignInput(), { target: { value: 'dl1dup' } });
    const hint = await screen.findByTestId('rtty-worked-hint');
    expect(hint.getAttribute('data-worked')).toBe('dupe');
    expect(mocks.api.getLogBookQSOs).toHaveBeenCalledWith('K1ABC', expect.objectContaining({ callsign: 'DL1DUP' }));
    expect((screen.getByRole('button', { name: 'radio:rtty.qso.logQSO' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not run ESM from a touch keyboard', () => {
    const step = vi.fn();
    const unregister = registerRttyEsmStep(step);
    render(ui());
    fireEvent.change(callsignInput(), { target: { value: 'ja1xyz' } });
    fireEvent.keyDown(callsignInput(), { key: 'Enter' });
    expect(step).not.toHaveBeenCalled();
    unregister();
  });
});
