// @vitest-environment jsdom
/**
 * Characterization tests for the CW QSO log card: form defaults, input
 * normalization, the createQSO payload, keyer-driven start/end times and the
 * two-way his-callsign sync with the shared CW QSO draft store.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CWKeyerStatus, QSORecord } from '@tx5dr/contracts';
import { createStorageStub } from './cwTestStorage';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  keyerStatus: null as Partial<CWKeyerStatus> | null,
  frequency: 14_025_000 as number | null,
  service: { wsClientInstance: { send: vi.fn(), onWSEvent: vi.fn(), offWSEvent: vi.fn() } },
  operators: [{ id: 'op1', context: { myCall: 'BG5DRB', myGrid: 'OM88' } }],
  api: { createQSO: vi.fn(), updateQSO: vi.fn(), deleteQSO: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@heroui/toast', () => ({ addToast: mocks.toast }));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock('../../../utils/windowManager', () => ({ openLogbookWindow: vi.fn() }));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { isConnected: true, radioService: mocks.service } }),
  useCWState: () => ({ cwKeyerStatus: mocks.keyerStatus, cwConfig: null }),
  useRadioModeState: () => ({ engineMode: 'cw', currentRadioFrequency: mocks.frequency, currentRadioMode: 'CW' }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'op1', setCurrentOperatorId: vi.fn() }),
  useOperators: () => ({ operators: mocks.operators }),
}));

import { CWQSOLogCard } from '../CWQSOLogCard';
import { setCWQSOHisCallsign, setCWQSORrst, setCWQSOTrst, useCWQSODraft } from '../../../store/cwQsoDraftStore';

const ui = (props: React.ComponentProps<typeof CWQSOLogCard> = {}) => (
  <HeroUIProvider disableAnimation><CWQSOLogCard {...props} /></HeroUIProvider>
);

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function readDraft() {
  const { result, unmount } = renderHook(() => useCWQSODraft());
  const value = result.current;
  unmount();
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  mocks.keyerStatus = null;
  mocks.frequency = 14_025_000;
  mocks.api.createQSO.mockResolvedValue({ success: true });
  setCWQSOHisCallsign('');
  setCWQSOTrst('5NN');
  setCWQSORrst('5NN');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CWQSOLogCard form', () => {
  it('defaults both reports to 599 and resets the shared draft reports to 599 on mount', () => {
    render(ui());
    expect(input('radio:cw.qso.rstSent').value).toBe('599');
    expect(input('radio:cw.qso.rstReceived').value).toBe('599');
    expect(screen.getAllByText('BG5DRB').length).toBeGreaterThan(0);
    expect(screen.getByText('CW')).toBeTruthy();
    expect(screen.getByText('14.025 MHz')).toBeTruthy();
    expect(readDraft()).toEqual({ hisCallsign: '', trst: '599', rrst: '599' });
  });

  it('truncates RST inputs to three characters, upper-cases them and mirrors them into the draft store', () => {
    render(ui());
    fireEvent.change(input('radio:cw.qso.rstSent'), { target: { value: '5nnx' } });
    fireEvent.change(input('radio:cw.qso.rstReceived'), { target: { value: '57' } });
    expect(input('radio:cw.qso.rstSent').value).toBe('5NN');
    expect(input('radio:cw.qso.rstReceived').value).toBe('57');
    expect(readDraft()).toMatchObject({ trst: '5NN', rrst: '57' });
  });

  it('upper-cases the callsign and publishes it to the draft store', () => {
    render(ui());
    fireEvent.change(input('radio:cw.qso.callsign'), { target: { value: 'ja1abc' } });
    expect(input('radio:cw.qso.callsign').value).toBe('JA1ABC');
    expect(readDraft().hisCallsign).toBe('JA1ABC');
  });

  it('follows his-callsign updates made elsewhere through the draft store', () => {
    render(ui());
    act(() => setCWQSOHisCallsign(' dl1xyz '));
    expect(input('radio:cw.qso.callsign').value).toBe('DL1XYZ');
  });

  it('disables logging until a callsign is entered', () => {
    render(ui());
    expect((screen.getByRole('button', { name: 'radio:cw.qso.logQSO' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates a CW QSO in the operator logbook and resets the form and draft', async () => {
    render(ui());
    fireEvent.change(input('radio:cw.qso.callsign'), { target: { value: 'ja1abc' } });
    fireEvent.change(input('radio:cw.qso.rstSent'), { target: { value: '579' } });
    fireEvent.change(input('radio:cw.qso.qth'), { target: { value: 'Tokyo' } });
    fireEvent.change(input('radio:cw.qso.grid'), { target: { value: 'pm95' } });
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.qso.logQSO' }));
    await waitFor(() => expect(mocks.api.createQSO).toHaveBeenCalledTimes(1));
    const [logbookId, body] = mocks.api.createQSO.mock.calls[0];
    expect(logbookId).toBe('BG5DRB');
    expect(body).toMatchObject({
      callsign: 'JA1ABC',
      frequency: 14_025_000,
      mode: 'CW',
      reportSent: '579',
      reportReceived: '599',
      messageHistory: [],
      qth: 'Tokyo',
      grid: 'PM95',
      comment: undefined,
    });
    expect(typeof body.startTime).toBe('number');
    expect(typeof body.endTime).toBe('number');
    await waitFor(() => expect(input('radio:cw.qso.callsign').value).toBe(''));
    expect(input('radio:cw.qso.rstSent').value).toBe('599');
    expect(readDraft()).toEqual({ hisCallsign: '', trst: '599', rrst: '599' });
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'success' }));
  });

  it('records start on the first keyer activation and end when the keyer goes idle', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(Date.UTC(2026, 0, 2, 3, 4, 5));
    const view = render(ui());
    expect(screen.getAllByText('--:--:--')).toHaveLength(2);

    mocks.keyerStatus = { active: true, mode: 'playing' };
    view.rerender(ui());
    expect(screen.getByText('03:04:05')).toBeTruthy();

    now.mockReturnValue(Date.UTC(2026, 0, 2, 3, 6, 0));
    mocks.keyerStatus = { active: false, mode: 'idle' };
    view.rerender(ui());
    // A second over does not move the start time.
    now.mockReturnValue(Date.UTC(2026, 0, 2, 3, 7, 0));
    mocks.keyerStatus = { active: true, mode: 'playing' };
    view.rerender(ui());
    now.mockReturnValue(Date.UTC(2026, 0, 2, 3, 8, 30));
    mocks.keyerStatus = { active: false, mode: 'idle' };
    view.rerender(ui());
    expect(screen.getByText('03:04:05')).toBeTruthy();
    expect(screen.getByText('03:08:30')).toBeTruthy();

    fireEvent.change(input('radio:cw.qso.callsign'), { target: { value: 'ja1abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.qso.logQSO' }));
    await waitFor(() => expect(mocks.api.createQSO).toHaveBeenCalled());
    expect(mocks.api.createQSO.mock.calls[0][1]).toMatchObject({
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      endTime: Date.UTC(2026, 0, 2, 3, 8, 30),
    });
  });

  it('the clear button resets the form and the draft callsign', () => {
    render(ui());
    fireEvent.change(input('radio:cw.qso.callsign'), { target: { value: 'ja1abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.qso.clear' }));
    expect(input('radio:cw.qso.callsign').value).toBe('');
    expect(readDraft().hisCallsign).toBe('');
  });
});

describe('CWQSOLogCard editing', () => {
  const editingQSO = {
    id: 'q1',
    callsign: 'K1ABC',
    frequency: 7_030_000,
    mode: 'CW',
    startTime: Date.UTC(2026, 0, 1, 10, 0, 0),
    endTime: Date.UTC(2026, 0, 1, 10, 5, 0),
    reportSent: '579',
    reportReceived: '569',
    messages: [],
    myCallsign: 'BG5DRB',
  } as unknown as QSORecord;

  it('loads the record into the form, publishes its callsign and saves through updateQSO with mode CW', async () => {
    mocks.api.updateQSO.mockResolvedValue({ success: true, data: { ...editingQSO, reportSent: '599' } });
    const onEditComplete = vi.fn();
    render(ui({ editingQSO, onEditComplete }));
    expect(input('radio:cw.qso.callsign').value).toBe('K1ABC');
    expect(input('radio:cw.qso.rstSent').value).toBe('579');
    expect(screen.getByText('7.030 MHz')).toBeTruthy();
    expect(readDraft().hisCallsign).toBe('K1ABC');

    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.qso.save' }));
    await waitFor(() => expect(mocks.api.updateQSO).toHaveBeenCalledTimes(1));
    expect(mocks.api.updateQSO).toHaveBeenCalledWith('BG5DRB', 'q1', expect.objectContaining({
      callsign: 'K1ABC',
      frequency: 7_030_000,
      mode: 'CW',
      startTime: editingQSO.startTime,
      endTime: editingQSO.endTime,
      reportSent: '579',
      reportReceived: '569',
    }));
    await waitFor(() => expect(onEditComplete).toHaveBeenCalled());
  });
});
