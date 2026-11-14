// @vitest-environment jsdom
/**
 * Characterization tests for the CW keyer panel.
 *
 * These pin user-visible behaviour and the persistence / wire contracts
 * (WebSocket payloads, REST calls, localStorage keys and formats) so that a
 * refactor extracting shared keyer components keeps CW behaviour unchanged.
 * Only external boundaries are replaced: the REST api, the WS client, the
 * radio store projection and toasts.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CWKeyerStatus, CWMessagePanel } from '@tx5dr/contracts';
import { createStorageStub } from './cwTestStorage';

const mocks = vi.hoisted(() => {
  const send = vi.fn();
  return {
    send,
    toast: vi.fn(),
    setCurrentOperatorId: vi.fn(),
    engineMode: 'cw' as string,
    keyerStatus: null as CWKeyerStatus | null,
    service: { wsClientInstance: { send: (...args: unknown[]) => send(...args) } },
    operators: [{ id: 'op1', context: { myCall: 'BG5DRB' } }],
    radioConnection: { radioConnected: true, radioConfig: { type: 'serial' } },
    api: {
      getCWKeyerConfig: vi.fn(),
      updateCWKeyerConfig: vi.fn(),
      getCWMessagePanel: vi.fn(),
      updateCWMessagePanel: vi.fn(),
      updateCWMessageSlot: vi.fn(),
      deleteCWMessageSlot: vi.fn(),
      swapCWMessageSlots: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@heroui/toast', () => ({ addToast: mocks.toast }));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { isConnected: true, radioService: mocks.service } }),
  useCWState: () => ({ cwKeyerStatus: mocks.keyerStatus, cwConfig: null }),
  useRadioModeState: () => ({ engineMode: mocks.engineMode }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'op1', setCurrentOperatorId: mocks.setCurrentOperatorId }),
  useOperators: () => ({ operators: mocks.operators }),
  useRadioConnectionState: () => mocks.radioConnection,
}));

import { CWKeyerPanel } from '../CWKeyerPanel';
import { setCWQSOHisCallsign, setCWQSORrst, setCWQSOTrst } from '../../../store/cwQsoDraftStore';

const SHORTCUT_KEY = 'tx5dr_cw_keyer_shortcut_presets';

function makePanel(overrides: Partial<CWMessagePanel> = {}): CWMessagePanel {
  return {
    callsign: 'BG5DRB',
    slotCount: 3,
    maxSlotCount: 12,
    slots: [
      { id: 's1', index: 1, label: 'CQ', text: 'CQ DE {MYCALL}', repeatEnabled: false, repeatIntervalSec: 5 },
      { id: 's2', index: 2, label: 'Report', text: '{HISCALL} UR {TRST}', repeatEnabled: false, repeatIntervalSec: 5 },
      { id: 's3', index: 3, label: 'Thanks', text: 'R {RRST} TU 73', repeatEnabled: false, repeatIntervalSec: 5 },
      { id: 's4', index: 4, label: 'Hidden', text: 'HIDDEN SLOT', repeatEnabled: false, repeatIntervalSec: 5 },
    ],
    ...overrides,
  } as CWMessagePanel;
}

function activeStatus(overrides: Partial<CWKeyerStatus> = {}): CWKeyerStatus {
  return {
    active: true,
    mode: 'playing',
    startedBy: 'client',
    startedByLabel: null,
    messageId: 's1',
    nextRunAt: null,
    error: null,
    ...overrides,
  } as CWKeyerStatus;
}

const ui = () => <HeroUIProvider disableAnimation><CWKeyerPanel /></HeroUIProvider>;

async function mountPanel() {
  const view = render(ui());
  await screen.findByText('CQ', { selector: 'span' });
  // Let the shortcut presets derived from the loaded panel settle.
  await act(async () => {});
  return view;
}

function sentMessages(type: string) {
  return mocks.send.mock.calls.filter(([messageType]) => messageType === type).map(([, payload]) => payload);
}

function iconButton(container: HTMLElement, icon: string): HTMLButtonElement {
  const button = container.querySelector(`svg[data-icon="${icon}"]`)?.closest('button');
  if (!button) throw new Error(`No button with icon ${icon}`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  mocks.engineMode = 'cw';
  mocks.keyerStatus = null;
  mocks.api.getCWKeyerConfig.mockResolvedValue({ success: true, config: { backend: 'serial', keyPort: '/dev/ttyUSB0', keyMethod: 'dtr', keyActiveLevel: 'high', wpm: 20 } });
  mocks.api.updateCWKeyerConfig.mockImplementation(async (body: object) => ({ success: true, config: { backend: 'serial', keyPort: '/dev/ttyUSB0', keyMethod: 'dtr', keyActiveLevel: 'high', wpm: 20, ...body } }));
  mocks.api.getCWMessagePanel.mockImplementation(async () => ({ success: true, panel: makePanel() }));
  mocks.api.updateCWMessagePanel.mockImplementation(async (_callsign: string, body: { slotCount: number }) => ({ success: true, panel: makePanel({ slotCount: body.slotCount }) }));
  mocks.api.updateCWMessageSlot.mockImplementation(async (_callsign: string, slotId: string, body: object) => {
    const panel = makePanel();
    return { success: true, panel: { ...panel, slots: panel.slots.map(slot => slot.id === slotId ? { ...slot, ...body } : slot) } };
  });
  mocks.api.deleteCWMessageSlot.mockImplementation(async () => ({ success: true, panel: makePanel() }));
  mocks.api.swapCWMessageSlots.mockImplementation(async () => ({ success: true, panel: makePanel() }));
  // The draft store is module state shared across tests.
  setCWQSOHisCallsign('JA1ABC');
  setCWQSOTrst('579');
  setCWQSORrst('559');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CWKeyerPanel message slots', () => {
  it('loads the panel for the current operator callsign and renders only the visible slots with resolved placeholders', async () => {
    await mountPanel();
    expect(mocks.api.getCWMessagePanel).toHaveBeenCalledWith('BG5DRB');
    expect(screen.getByRole('button', { name: /CQ DE BG5DRB/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /JA1ABC UR 579/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /R 559 TU 73/ })).toBeTruthy();
    expect(screen.queryByText('HIDDEN SLOT')).toBeNull();
    // Default shortcuts follow slot index.
    expect(screen.getByRole('button', { name: /F1.*CQ DE BG5DRB/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /F3.*R 559 TU 73/ })).toBeTruthy();
  });

  it('renders nothing and does not load the panel outside CW mode', async () => {
    mocks.engineMode = 'digital';
    const { container } = render(ui());
    await act(async () => {});
    expect(container.textContent).toBe('');
    expect(mocks.api.getCWMessagePanel).not.toHaveBeenCalled();
  });

  it('sends CW_PLAY_MESSAGE with the slot id and the raw placeholder values when a slot is clicked', async () => {
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /JA1ABC UR 579/ }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith('cwPlayMessage', {
      callsign: 'BG5DRB',
      slotId: 's2',
      repeat: false,
      startImmediately: true,
      placeholderValues: { myCall: 'BG5DRB', hisCall: 'JA1ABC', trst: '579', rrst: '559' },
      operatorId: 'op1',
    });
  });

  it('warns and does not send when a slot needs a missing placeholder value', async () => {
    act(() => setCWQSOHisCallsign(''));
    await mountPanel();
    // The unresolved placeholder is shown with its missing-value label.
    const slot = screen.getByRole('button', { name: /radio:cw\.placeholderMissingHisCall UR 579/ });
    fireEvent.click(slot);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'warning', title: 'radio:cw.placeholderMissingTitle' }));
  });

  it('clicking the active slot stops it with CW_STOP_MESSAGE', async () => {
    mocks.keyerStatus = activeStatus({ messageId: 's1' });
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /CQ DE BG5DRB/ }));
    expect(sentMessages('cwStopMessage')).toEqual([{}]);
    expect(sentMessages('cwPlayMessage')).toEqual([]);
  });

  it('toggling repeat persists repeatEnabled and starts a repeat play that waits for the interval', async () => {
    await mountPanel();
    const toggles = screen.getAllByRole('button', { name: 'radio:cw.repeatToggle' });
    fireEvent.click(toggles[0]);
    await waitFor(() => expect(sentMessages('cwPlayMessage')).toHaveLength(1));
    expect(mocks.api.updateCWMessageSlot).toHaveBeenCalledWith('BG5DRB', 's1', { repeatEnabled: true });
    expect(sentMessages('cwPlayMessage')[0]).toEqual({
      callsign: 'BG5DRB',
      slotId: 's1',
      repeat: true,
      startImmediately: false,
      placeholderValues: { myCall: 'BG5DRB', hisCall: 'JA1ABC', trst: '579', rrst: '559' },
      operatorId: 'op1',
    });
  });

  it('debounces repeat interval edits into a single slot update', async () => {
    await mountPanel();
    vi.useFakeTimers();
    try {
      const interval = screen.getAllByRole('spinbutton', { name: 'radio:cw.repeatInterval' })[0] as HTMLInputElement;
      fireEvent.change(interval, { target: { value: '12' } });
      fireEvent.change(interval, { target: { value: '500' } });
      expect(mocks.api.updateCWMessageSlot).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(mocks.api.updateCWMessageSlot).toHaveBeenCalledTimes(1);
      // Values are clamped to 1..300 seconds.
      expect(mocks.api.updateCWMessageSlot).toHaveBeenCalledWith('BG5DRB', 's1', { repeatIntervalSec: 300 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CWKeyerPanel global shortcuts', () => {
  it('maps F1-F12 to slots by index while in CW mode', async () => {
    await mountPanel();
    fireEvent.keyDown(window, { key: 'F3', code: 'F3' });
    expect(sentMessages('cwPlayMessage')).toEqual([expect.objectContaining({ slotId: 's3', repeat: false, startImmediately: true })]);
    // F4 belongs to a slot hidden by slotCount.
    fireEvent.keyDown(window, { key: 'F4', code: 'F4' });
    expect(sentMessages('cwPlayMessage')).toHaveLength(1);
  });

  it('fires F-keys even when focus is in a text input', async () => {
    await mountPanel();
    const input = screen.getByPlaceholderText('radio:cw.textInputPlaceholder');
    fireEvent.keyDown(input, { key: 'F1', code: 'F1' });
    expect(sentMessages('cwPlayMessage')).toEqual([expect.objectContaining({ slotId: 's1' })]);
  });

  it('ignores F-keys outside CW mode', async () => {
    mocks.engineMode = 'voice';
    render(ui());
    await act(async () => {});
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('ignores F-keys while the keyer is active and Escape stops it', async () => {
    mocks.keyerStatus = activeStatus({ messageId: 's2' });
    await mountPanel();
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    expect(sentMessages('cwPlayMessage')).toEqual([]);
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(mocks.send).toHaveBeenCalledWith('cwStopMessage', {});
  });

  it('Escape does nothing while idle', async () => {
    await mountPanel();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not trigger shortcuts while the edit tab is selected', async () => {
    await mountPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'radio:cw.editMode' }));
    await screen.findAllByLabelText('radio:cw.messageText');
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('reads per-callsign shortcut presets from tx5dr_cw_keyer_shortcut_presets', async () => {
    localStorage.setItem(SHORTCUT_KEY, JSON.stringify({ bg5drb: { s1: 'F9', s2: 'None' } }));
    await mountPanel();
    expect(screen.getByRole('button', { name: /F9.*CQ DE BG5DRB/ })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    fireEvent.keyDown(window, { key: 'F2', code: 'F2' });
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'F9', code: 'F9' });
    expect(sentMessages('cwPlayMessage')).toEqual([expect.objectContaining({ slotId: 's1' })]);
  });
});

describe('CWKeyerPanel text input', () => {
  it('buffered mode upper-cases input and sends the whole text on Enter as CW_TEXT_INPUT', async () => {
    await mountPanel();
    const input = screen.getByPlaceholderText('radio:cw.textInputPlaceholder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'cq {hiscall} k' } });
    expect(input.value).toBe('CQ {HISCALL} K');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(sentMessages('cwTextInput')).toEqual([{
      text: 'CQ {HISCALL} K',
      callsign: 'BG5DRB',
      placeholderValues: { myCall: 'BG5DRB', hisCall: 'JA1ABC', trst: '579', rrst: '559' },
      operatorId: 'op1',
    }]);
    await waitFor(() => expect(input.value).toBe(''));
    // The resolved text is offered as a "last sent" resend button.
    expect(screen.getByRole('button', { name: /radio:cw\.lastSent.*CQ JA1ABC K/ })).toBeTruthy();
  });

  it('the send button sends the buffered text too', async () => {
    await mountPanel();
    const input = screen.getByPlaceholderText('radio:cw.textInputPlaceholder');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.send' }));
    expect(sentMessages('cwTextInput')).toEqual([expect.objectContaining({ text: 'TEST' })]);
  });

  it('buffered text with a missing placeholder warns and is not sent', async () => {
    act(() => setCWQSOHisCallsign(''));
    await mountPanel();
    const input = screen.getByPlaceholderText('radio:cw.textInputPlaceholder');
    fireEvent.change(input, { target: { value: '{HISCALL} 5NN' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'warning' }));
  });

  it('realtime mode (persisted in tx5dr_cw_text_input_mode) queues each typed character as its own CW_TEXT_INPUT', async () => {
    localStorage.setItem('tx5dr_cw_text_input_mode', 'realtime');
    await mountPanel();
    const input = screen.getByPlaceholderText('radio:cw.realtimeTextInputPlaceholder') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'c', code: 'KeyC' });
    expect(input.value).toBe('C');
    await waitFor(() => expect(sentMessages('cwTextInput')).toEqual([
      expect.objectContaining({ text: 'C', callsign: 'BG5DRB', operatorId: 'op1' }),
    ]));
    expect(screen.queryByRole('button', { name: 'radio:cw.send' })).toBeNull();
  });

  it('the realtime switch writes the text input mode to localStorage', async () => {
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.settings' }));
    const toggle = await screen.findByRole('switch', { name: 'radio:cw.textInputModeRealtime' });
    fireEvent.click(toggle);
    expect(localStorage.getItem('tx5dr_cw_text_input_mode')).toBe('realtime');
    fireEvent.click(toggle);
    expect(localStorage.getItem('tx5dr_cw_text_input_mode')).toBe('buffered');
  });
});

describe('CWKeyerPanel sidetone persistence', () => {
  it('defaults to enabled, 700 Hz and 30% volume', async () => {
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.settings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('ON')).toBeTruthy();
    expect(within(dialog).getByText('700Hz')).toBeTruthy();
    expect(within(dialog).getByText('30%')).toBeTruthy();
  });

  it('reads stored values and clamps them to their ranges', async () => {
    localStorage.setItem('tx5dr_cw_sidetone_frequency', '5000');
    localStorage.setItem('tx5dr_cw_sidetone_volume', '0.01');
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.settings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1200Hz')).toBeTruthy();
    expect(within(dialog).getByText('5%')).toBeTruthy();
  });

  it('stores the enabled flag as the string "true"/"false"', async () => {
    localStorage.setItem('tx5dr_cw_sidetone_enabled', 'false');
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.settings' }));
    const dialog = await screen.findByRole('dialog');
    const button = within(dialog).getByRole('button', { name: 'OFF' });
    expect(within(dialog).queryByText('700Hz')).toBeNull();
    fireEvent.click(button);
    expect(localStorage.getItem('tx5dr_cw_sidetone_enabled')).toBe('true');
    expect(within(dialog).getByText('700Hz')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'ON' }));
    expect(localStorage.getItem('tx5dr_cw_sidetone_enabled')).toBe('false');
  });

  it('stores pitch and volume slider changes as plain numbers', async () => {
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'radio:cw.settings' }));
    const dialog = await screen.findByRole('dialog');
    const pitch = within(dialog).getByRole('slider', { name: 'radio:cw.sidetoneFrequency' });
    fireEvent.keyDown(pitch, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(localStorage.getItem('tx5dr_cw_sidetone_frequency')).toBe('710');
    const volume = within(dialog).getByRole('slider', { name: 'radio:cw.sidetoneVolume' });
    fireEvent.keyDown(volume, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(Number(localStorage.getItem('tx5dr_cw_sidetone_volume'))).toBeCloseTo(0.35);
  });
});

describe('CWKeyerPanel edit tab', () => {
  async function openEditTab() {
    const view = await mountPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'radio:cw.editMode' }));
    await screen.findAllByLabelText('radio:cw.messageText');
    return view;
  }

  it('changing the slot count calls updateCWMessagePanel with the new count', async () => {
    const { container } = await openEditTab();
    fireEvent.click(iconButton(container, 'plus'));
    await waitFor(() => expect(mocks.api.updateCWMessagePanel).toHaveBeenCalledWith('BG5DRB', { slotCount: 4 }));
    await waitFor(() => expect(screen.getAllByLabelText('radio:cw.messageText')).toHaveLength(4));
  });

  it('cannot decrease below three slots', async () => {
    const { container } = await openEditTab();
    expect(iconButton(container, 'minus').disabled).toBe(true);
  });

  it('saves edited slot text on blur and clears a slot through deleteCWMessageSlot', async () => {
    await openEditTab();
    const text = screen.getAllByLabelText('radio:cw.messageText')[0] as HTMLInputElement;
    fireEvent.change(text, { target: { value: 'CQ TEST {MYCALL}' } });
    fireEvent.blur(text);
    await waitFor(() => expect(mocks.api.updateCWMessageSlot).toHaveBeenCalledWith('BG5DRB', 's1', { text: 'CQ TEST {MYCALL}' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'radio:cw.clearSlot' })[1]);
    await waitFor(() => expect(mocks.api.deleteCWMessageSlot).toHaveBeenCalledWith('BG5DRB', 's2'));
  });

  it('dragging one slot onto another swaps them on the server and swaps their stored shortcuts', async () => {
    await openEditTab();
    const rows = screen.getAllByLabelText('radio:cw.messageText').map(input => input.closest('[draggable]') as HTMLElement);
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragOver(rows[1], { dataTransfer });
    fireEvent.drop(rows[1], { dataTransfer });
    await waitFor(() => expect(mocks.api.swapCWMessageSlots).toHaveBeenCalledWith('BG5DRB', 's1', 's2'));
    expect(JSON.parse(localStorage.getItem(SHORTCUT_KEY) ?? '{}')).toEqual({ BG5DRB: { s1: 'F2', s2: 'F1' } });
  });
});
