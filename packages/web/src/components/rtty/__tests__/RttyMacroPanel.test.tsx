// @vitest-environment jsdom
/**
 * RTTY macro panel: the shared keyboard macro panel wired to the RTTY REST
 * adapter, the RTTY QSO draft placeholders and type-ahead F-key hotkeys.
 * The REST api, the radio store projection and the RTTY context are replaced.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardMessagePanel, RttyTxStatus } from '@tx5dr/contracts';
import type { RttyTranscript } from '../../../hooks/useRtty';
import { createStorageStub } from '../../cw/__tests__/cwTestStorage';
import { chars, txStatus } from './rttyTestFixtures';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  transcript: { sessionId: 's1', segments: [], lastSequence: 0 } as RttyTranscript,
  rtty: {
    config: null,
    txStatus: null as RttyTxStatus | null,
    isRttyMode: true,
    canTransmit: true,
    playMessage: vi.fn(),
    abort: vi.fn(),
    append: vi.fn(),
    retract: vi.fn(),
    finish: vi.fn(),
  },
  api: {
    getRttyMessagePanel: vi.fn(),
    updateRttyMessagePanel: vi.fn(),
    updateRttyMessageSlot: vi.fn(),
    deleteRttyMessageSlot: vi.fn(),
    swapRttyMessageSlots: vi.fn(),
  },
}));

vi.mock('../../../store/authStore', () => ({ useAuth: () => ({ state: { label: 'Me' } }), useCan: () => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@heroui/toast', () => ({ addToast: mocks.toast }));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock('../../../store/radioStore', () => ({
  useOperators: () => ({ operators: [{ id: 'op1', context: { myCall: 'K1ABC' } }] }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'op1', setCurrentOperatorId: vi.fn() }),
}));
vi.mock('../../../hooks/useRtty', () => ({
  useRtty: () => mocks.rtty,
  useRttyTranscript: () => ({ transcript: mocks.transcript, clearTranscript: vi.fn() }),
}));

import { RttyMacroPanel } from '../RttyMacroPanel';
import { rttyQsoDraftStore } from '../../../store/rttyQsoDraftStore';
import { registerRttyQsoLogger, runRttyEsmStep } from '../rttyQsoActions';

let panelOverrides: Partial<Record<string, Partial<KeyboardMessagePanel['slots'][number]>>> = {};

function makePanel(slotCount = 3): KeyboardMessagePanel {
  const slots: KeyboardMessagePanel['slots'] = [
    { id: 'cq', index: 1, label: 'CQ', text: 'CQ CQ DE {MYCALL} {MYCALL} K {RX}', repeatEnabled: false, repeatIntervalSec: 5 },
    { id: 'exch', index: 2, label: 'EXCH', text: '{HISCALL} UR {TRST} {TRST}', repeatEnabled: false, repeatIntervalSec: 5 },
    { id: 'tu', index: 3, label: 'TU', text: 'TU 73 {RX}', repeatEnabled: false, repeatIntervalSec: 5 },
    { id: 'rexch', index: 4, label: 'R EXCH', text: '{HISCALL} R TU UR {TRST} {RX}', repeatEnabled: false, repeatIntervalSec: 5 },
  ];
  return {
    callsign: 'K1ABC',
    slotCount,
    maxSlotCount: 12,
    slots: slots.map((slot) => ({ ...slot, ...panelOverrides[slot.id] })),
  };
}

const ui = () => <HeroUIProvider disableAnimation><RttyMacroPanel /></HeroUIProvider>;

async function mountPanel() {
  const view = render(ui());
  await screen.findByText('CQ', { selector: 'span' });
  await act(async () => {});
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  mocks.rtty.txStatus = txStatus();
  mocks.transcript = { sessionId: 's1', segments: [], lastSequence: 0 };
  panelOverrides = {};
  mocks.rtty.isRttyMode = true;
  mocks.rtty.canTransmit = true;
  mocks.api.getRttyMessagePanel.mockImplementation(async () => ({ success: true, panel: makePanel() }));
  mocks.api.updateRttyMessageSlot.mockImplementation(async (_callsign: string, slotId: string, update: object) => {
    panelOverrides[slotId] = { ...panelOverrides[slotId], ...update };
    return { success: true, panel: makePanel() };
  });
  // The draft store is module state shared across tests.
  rttyQsoDraftStore.setHisCallsign('JA1XYZ');
  rttyQsoDraftStore.setTrst('599');
  rttyQsoDraftStore.setRrst('579');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EXPECTED_VALUES = { myCall: 'K1ABC', hisCall: 'JA1XYZ', trst: '599', rrst: '579' };

describe('RttyMacroPanel', () => {
  it('loads the RTTY panel for the operator callsign and resolves placeholders from the RTTY draft', async () => {
    await mountPanel();
    expect(mocks.api.getRttyMessagePanel).toHaveBeenCalledWith('K1ABC');
    expect(screen.getByRole('button', { name: /F1.*CQ CQ DE K1ABC K1ABC K \{RX\}/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /F2.*JA1XYZ UR 599 599/ })).toBeTruthy();
    // The transmit buffer is the input area.
    expect(screen.getByTestId('rtty-tx-buffer')).toBeTruthy();
  });

  it('F1 plays the slot with the resolved placeholder values', async () => {
    await mountPanel();
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    expect(mocks.rtty.playMessage).toHaveBeenCalledWith('K1ABC', 'cq', EXPECTED_VALUES);
  });

  it('F-keys chain macros while a transmission is active, and Escape aborts it', async () => {
    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sessionId: 'tx1' });
    await mountPanel();
    fireEvent.keyDown(window, { key: 'F3', code: 'F3' });
    expect(mocks.rtty.playMessage).toHaveBeenCalledWith('K1ABC', 'tu', EXPECTED_VALUES);
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(mocks.rtty.abort).toHaveBeenCalledTimes(1);
  });

  it('does not send a slot whose {HISCALL} is missing and warns instead', async () => {
    rttyQsoDraftStore.setHisCallsign('');
    await mountPanel();
    fireEvent.keyDown(window, { key: 'F2', code: 'F2' });
    expect(mocks.rtty.playMessage).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'warning' }));
  });

  it('does not send when transmit is unavailable, and renders nothing outside RTTY mode', async () => {
    mocks.rtty.canTransmit = false;
    const view = await mountPanel();
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    fireEvent.click(screen.getByRole('button', { name: /TU 73/ }));
    expect(mocks.rtty.playMessage).not.toHaveBeenCalled();

    mocks.rtty.isRttyMode = false;
    view.rerender(ui());
    expect(screen.queryByTestId('rtty-tx-buffer')).toBeNull();
  });

  it('shows the slots as a compact grid: label and resolved preview, missing placeholders flagged', async () => {
    rttyQsoDraftStore.setHisCallsign('');
    await mountPanel();
    expect(screen.getByTestId('macro-grid')).toBeTruthy();
    const exch = screen.getByRole('button', { name: /F2.*EXCH/ });
    expect(exch.getAttribute('data-missing')).toBe('true');
    expect(screen.getByRole('button', { name: /F1.*CQ/ }).getAttribute('data-missing')).toBeNull();
    // The operate view uses Operate/Edit tabs (not "Transmit", which clashed with the TX button).
    expect(screen.getByText('radio:rtty.macro.operateMode')).toBeTruthy();
  });

  it('plays a repeat-enabled slot as a loop and stops the loop from its button and Escape', async () => {
    panelOverrides = { cq: { repeatEnabled: true, repeatIntervalSec: 8 } };
    const view = await mountPanel();
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    expect(mocks.rtty.playMessage).toHaveBeenLastCalledWith('K1ABC', 'cq', EXPECTED_VALUES, { repeat: true });

    // Waiting between transmissions: the slot counts down, its button cancels the loop.
    mocks.rtty.txStatus = txStatus({ repeat: { messageId: 'cq', intervalSec: 8, nextRunAt: Date.now() + 5000 } });
    view.rerender(ui());
    expect(screen.getByTestId('rtty-repeat').textContent).toContain('rtty.tx.repeatWaiting');
    fireEvent.click(screen.getByRole('button', { name: /F1.*CQ/ }));
    expect(mocks.rtty.playMessage).toHaveBeenLastCalledWith('K1ABC', 'cq', EXPECTED_VALUES, { repeat: false });

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(mocks.rtty.abort).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('rtty-tx-status').textContent).toContain('rtty.tx.stopped');
  });

  it('the repeat toggle only arms the macro (no key-up) and cancels a running loop when switched off', async () => {
    const view = await mountPanel();
    const toggles = screen.getAllByRole('button', { name: 'radio:rtty.macro.repeatToggle' });
    await act(async () => { fireEvent.click(toggles[0]!); });
    expect(mocks.api.updateRttyMessageSlot).toHaveBeenCalledWith('K1ABC', 'cq', { repeatEnabled: true });
    expect(mocks.rtty.playMessage).not.toHaveBeenCalled();

    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', repeat: { messageId: 'cq', intervalSec: 5, nextRunAt: null } });
    view.rerender(ui());
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'radio:rtty.macro.repeatToggle' })[0]!); });
    expect(mocks.api.updateRttyMessageSlot).toHaveBeenLastCalledWith('K1ABC', 'cq', { repeatEnabled: false });
    expect(mocks.rtty.playMessage).toHaveBeenLastCalledWith('K1ABC', 'cq', EXPECTED_VALUES, { repeat: false });
  });

  it('shows that the transmission returns to receive after the buffer, with an RX marker', async () => {
    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', finishing: true, sentText: 'CQ ', pendingText: 'DE K1ABC' });
    await mountPanel();
    expect(screen.getByTestId('rtty-finishing')).toBeTruthy();
    expect(screen.getByTestId('rtty-rx-marker')).toBeTruthy();
  });
});

describe('RTTY keyboard flow', () => {
  it('Alt+G grabs the newest received callsign that is not my own into the QSO draft', async () => {
    rttyQsoDraftStore.setHisCallsign('');
    mocks.transcript = {
      sessionId: 's1',
      lastSequence: 2,
      segments: [
        { kind: 'rx', id: 'a', characters: chars('CQ TEST DE W1OLD W1OLD ') },
        { kind: 'tx', id: 'b', sessionId: 't', text: 'CQ DE K1ABC', startedAt: 0 },
        { kind: 'rx', id: 'c', characters: chars('K1ABC DE JA1XYZ JA1XYZ K1ABC K') },
      ],
    };
    await mountPanel();
    fireEvent.keyDown(window, { key: '©', code: 'KeyG', altKey: true });
    expect(rttyQsoDraftStore.getSnapshot().hisCallsign).toBe('JA1XYZ');
  });

  it('Ctrl+Enter and Cmd+Enter log through the registered QSO log card', async () => {
    const log = vi.fn(async () => true);
    const unregister = registerRttyQsoLogger(log);
    await mountPanel();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(log).toHaveBeenCalledTimes(2);
    unregister();
  });

  it('ESM: after our CQ, Enter sends EXCH, then TU and logs', async () => {
    const log = vi.fn(async () => true);
    const unregister = registerRttyQsoLogger(log);
    mocks.rtty.txStatus = txStatus({ messageId: 'cq' });
    await mountPanel();
    act(() => { runRttyEsmStep(); });
    expect(mocks.rtty.playMessage).toHaveBeenLastCalledWith('K1ABC', 'exch', EXPECTED_VALUES);
    act(() => { runRttyEsmStep(); });
    expect(mocks.rtty.playMessage).toHaveBeenLastCalledWith('K1ABC', 'tu', EXPECTED_VALUES);
    await act(async () => {});
    expect(log).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('ESM: when answering someone else, Enter sends R EXCH, then only logs', async () => {
    mocks.api.getRttyMessagePanel.mockImplementation(async () => ({ success: true, panel: makePanel(4) }));
    const log = vi.fn(async () => true);
    const unregister = registerRttyQsoLogger(log);
    await mountPanel();
    act(() => { runRttyEsmStep(); });
    expect(mocks.rtty.playMessage).toHaveBeenLastCalledWith('K1ABC', 'rexch', EXPECTED_VALUES);
    act(() => { runRttyEsmStep(); });
    await act(async () => {});
    expect(mocks.rtty.playMessage).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('ESM follows macros sent by hand: after F1 CQ and a manual EXCH, Enter sends TU and logs', async () => {
    const log = vi.fn(async () => true);
    const unregister = registerRttyQsoLogger(log);
    mocks.rtty.txStatus = txStatus({ sessionId: 'a', messageId: 'cq' });
    const view = await mountPanel();
    mocks.rtty.txStatus = txStatus({ sessionId: 'b', messageId: 'exch' });
    view.rerender(ui());
    await act(async () => {});
    act(() => { runRttyEsmStep(); });
    expect(mocks.rtty.playMessage).toHaveBeenLastCalledWith('K1ABC', 'tu', EXPECTED_VALUES);
    await act(async () => {});
    expect(log).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('holding an F-key sends the macro once', async () => {
    await mountPanel();
    fireEvent.keyDown(window, { key: 'F3', code: 'F3' });
    fireEvent.keyDown(window, { key: 'F3', code: 'F3', repeat: true });
    fireEvent.keyDown(window, { key: 'F3', code: 'F3', repeat: true });
    expect(mocks.rtty.playMessage).toHaveBeenCalledTimes(1);
  });
});
