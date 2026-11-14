// @vitest-environment jsdom
/**
 * RTTY transmit buffer: realtime keystrokes, paste, line mode and the
 * persisted input-mode choice. The RTTY context is replaced by a controllable
 * object so the test observes exactly what would be sent.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RttyTxStatus } from '@tx5dr/contracts';
import { createStorageStub } from '../../cw/__tests__/cwTestStorage';
import { txStatus } from './rttyTestFixtures';

const mocks = vi.hoisted(() => ({
  rtty: {
    txStatus: null as RttyTxStatus | null,
    canTransmit: true,
    isRttyMode: true,
    append: vi.fn(),
    retract: vi.fn(),
    finish: vi.fn(),
    abort: vi.fn(),
  },
}));

vi.mock('../../../store/authStore', () => ({ useAuth: () => ({ state: { label: 'Me' } }), useCan: () => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/useRtty', () => ({ useRtty: () => mocks.rtty }));

import { RttyTxBuffer } from '../RttyTxBuffer';
import { focusRttyTxBuffer } from '../rttyFocus';

const MODE_KEY = 'tx5dr_rtty_text_input_mode';
const VALUES = { myCall: 'K1ABC' };

const mount = () => render(
  <HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>,
);
const capture = () => screen.getByTestId('rtty-capture');
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  mocks.rtty.txStatus = txStatus();
  mocks.rtty.canTransmit = true;
  mocks.rtty.isRttyMode = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RttyTxBuffer realtime mode', () => {
  it('sends each printable key upper-cased, Enter as a newline only while transmitting, and ignores modified keys', () => {
    const view = mount();
    // A lone Enter while receiving does not key up.
    fireEvent.keyDown(capture(), { key: 'Enter' });
    expect(mocks.rtty.append).not.toHaveBeenCalled();
    fireEvent.keyDown(capture(), { key: 'c' });
    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sessionId: 's1' });
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    fireEvent.keyDown(capture(), { key: ' ' });
    fireEvent.keyDown(capture(), { key: 'Enter' });
    fireEvent.keyDown(capture(), { key: 'a', ctrlKey: true });
    fireEvent.keyDown(capture(), { key: 'Shift' });
    expect(mocks.rtty.append.mock.calls).toEqual([
      ['C', { placeholderValues: VALUES }],
      [' ', { placeholderValues: VALUES }],
      ['\n', { placeholderValues: VALUES }],
    ]);
  });

  it('Backspace always asks the server to retract; Escape aborts only an active session', () => {
    const view = mount();
    // The server ignores a retract with nothing unsent, so stale pending text must not gate it.
    fireEvent.keyDown(capture(), { key: 'Backspace' });
    expect(mocks.rtty.retract).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(capture(), { key: 'Escape' });
    expect(mocks.rtty.abort).not.toHaveBeenCalled();

    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sentText: 'CQ ', committedText: 'D', pendingText: 'E K1' });
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    expect(screen.getByTestId('rtty-sent').textContent).toBe('CQ ');
    expect(screen.getByTestId('rtty-committed').textContent).toBe('D');
    expect(screen.getByTestId('rtty-pending').textContent).toBe('E K1');

    fireEvent.keyDown(capture(), { key: 'Backspace' });
    expect(mocks.rtty.retract).toHaveBeenCalledWith(1);
    fireEvent.keyDown(capture(), { key: 'Escape' });
    expect(mocks.rtty.abort).toHaveBeenCalledTimes(1);
  });

  it('pastes upper-cased text capped at 480 characters', () => {
    mount();
    fireEvent.paste(capture(), { clipboardData: { getData: () => `cq de k1abc ${'x'.repeat(600)}` } });
    const [text, options] = mocks.rtty.append.mock.calls[0];
    expect(text).toHaveLength(480);
    expect(text.startsWith('CQ DE K1ABC X')).toBe(true);
    expect(options).toEqual({ placeholderValues: VALUES });
  });

  it('ignores input and disables TX when transmit is unavailable', () => {
    mocks.rtty.canTransmit = false;
    mocks.rtty.txStatus = txStatus({ available: false, unavailableReason: 'Radio disconnected' });
    mount();
    fireEvent.keyDown(capture(), { key: 'a' });
    fireEvent.keyDown(capture(), { key: 'Escape' });
    fireEvent.paste(capture(), { clipboardData: { getData: () => 'cq' } });
    expect(mocks.rtty.append).not.toHaveBeenCalled();
    expect(mocks.rtty.abort).not.toHaveBeenCalled();
    expect(button('rtty.tx.keyUp').disabled).toBe(true);
    expect(screen.getByText('Radio disconnected')).toBeTruthy();
    expect(screen.getByText('rtty.tx.placeholderDisabled')).toBeTruthy();
  });

  it('TX keys up with a newline while idle; RX finishes and Stop aborts while active', () => {
    const view = mount();
    expect(button('rtty.tx.receive').disabled).toBe(true);
    expect(button('rtty.tx.abort').disabled).toBe(true);
    fireEvent.click(button('rtty.tx.keyUp'));
    expect(mocks.rtty.append).toHaveBeenCalledWith('\n', { placeholderValues: VALUES });

    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sessionId: 'tx1' });
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    expect(button('rtty.tx.keyUp').disabled).toBe(true);
    fireEvent.click(button('rtty.tx.receive'));
    fireEvent.click(button('rtty.tx.abort'));
    expect(mocks.rtty.finish).toHaveBeenCalledTimes(1);
    expect(mocks.rtty.abort).toHaveBeenCalledTimes(1);
  });
});

describe('RttyTxBuffer line mode', () => {
  const lineInput = () => screen.getByPlaceholderText('rtty.tx.linePlaceholder') as HTMLInputElement;

  it('persists the mode switch and restores it on the next mount', () => {
    const view = mount();
    fireEvent.click(screen.getByRole('switch'));
    expect(localStorage.getItem(MODE_KEY)).toBe('line');
    expect(lineInput()).toBeTruthy();
    view.unmount();

    mount();
    expect(lineInput()).toBeTruthy();
    expect(screen.queryByTestId('rtty-capture')).toBeNull();
  });

  it('Enter sends the line on its own lines and finishes; a running session gets a leading space', () => {
    localStorage.setItem(MODE_KEY, 'line');
    const view = mount();
    fireEvent.change(lineInput(), { target: { value: 'cq de k1abc ' } });
    expect(lineInput().value).toBe('CQ DE K1ABC ');
    fireEvent.keyDown(lineInput(), { key: 'Enter' });
    expect(mocks.rtty.append).toHaveBeenLastCalledWith('\nCQ DE K1ABC\n', { finishAfter: true, placeholderValues: VALUES });
    expect(lineInput().value).toBe('');

    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sessionId: 'tx1' });
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    fireEvent.change(lineInput(), { target: { value: 'tu' } });
    fireEvent.click(button('rtty.tx.send'));
    expect(mocks.rtty.append).toHaveBeenLastCalledWith(' TU\n', { finishAfter: true, placeholderValues: VALUES });
  });

  it('does not send blank lines and is disabled without transmit permission', () => {
    localStorage.setItem(MODE_KEY, 'line');
    const view = mount();
    fireEvent.change(lineInput(), { target: { value: '   ' } });
    fireEvent.keyDown(lineInput(), { key: 'Enter' });
    expect(mocks.rtty.append).not.toHaveBeenCalled();

    mocks.rtty.canTransmit = false;
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    expect(lineInput().disabled).toBe(true);
  });
});

describe('RttyTxBuffer keyboard focus', () => {
  it('registers its focus target for other panels (mouse devices only)', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query === '(pointer: fine)', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    mount();
    expect(focusRttyTxBuffer()).toBe(true);
    expect(document.activeElement).toBe(capture());
    // Touch screens: focusing would pop up the soft keyboard.
    (document.activeElement as HTMLElement).blur();
    window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    expect(focusRttyTxBuffer()).toBe(false);
    window.matchMedia = original;
  });

  it('a stray key while receiving only focuses the buffer; during a transmission it is sent', () => {
    render(<button type="button">macro</button>);
    const view = mount();
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(mocks.rtty.append).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(capture());
    expect(screen.getByTestId('rtty-focus-hint').textContent).toBe('rtty.tx.focusHint');

    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sessionId: 's1' });
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'macro' }), { key: 'q' });
    // Never starts a new transmission if the server has just ended this one.
    expect(mocks.rtty.append).toHaveBeenLastCalledWith('Q', { start: false, placeholderValues: VALUES });
  });

  it('a stray key while the transmission is finishing or on a whole-message path only focuses the buffer', () => {
    render(<button type="button">macro</button>);
    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sessionId: 's1', finishing: true });
    const view = mount();
    fireEvent.keyDown(screen.getByRole('button', { name: 'macro' }), { key: 'q' });
    expect(mocks.rtty.append).not.toHaveBeenCalled();
    mocks.rtty.txStatus = txStatus({ active: true, phase: 'on_air', sessionId: 's1', typeAheadSupported: false });
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'macro' }), { key: 'q' });
    expect(mocks.rtty.append).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(capture());
  });

  it('never takes keys from other inputs, dialogs, modified keys or when transmit is unavailable', () => {
    render(
      <div>
        <input aria-label="other" />
        <div role="dialog"><button type="button">ok</button></div>
      </div>,
    );
    const view = mount();
    fireEvent.keyDown(screen.getByLabelText('other'), { key: 'a' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'ok' }), { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'F2' });
    expect(mocks.rtty.append).not.toHaveBeenCalled();

    mocks.rtty.canTransmit = false;
    view.rerender(<HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} /></HeroUIProvider>);
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(mocks.rtty.append).not.toHaveBeenCalled();
  });

  it('in line mode a stray key is inserted into the line instead of being sent', () => {
    localStorage.setItem(MODE_KEY, 'line');
    mount();
    fireEvent.keyDown(document.body, { key: 't' });
    const input = screen.getByPlaceholderText('rtty.tx.linePlaceholder') as HTMLInputElement;
    expect(input.value).toBe('T');
    expect(document.activeElement).toBe(input);
    expect(mocks.rtty.append).not.toHaveBeenCalled();
  });

  it('shows a waiting repeat and a stopped state; Stop also cancels a waiting repeat', () => {
    const onStop = vi.fn();
    mocks.rtty.txStatus = txStatus({ repeat: { messageId: 'cq', intervalSec: 8, nextRunAt: Date.now() + 8000 } });
    const view = render(
      <HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} repeatLabel="CQ" onStop={onStop} /></HeroUIProvider>,
    );
    expect(screen.getByTestId('rtty-repeat')).toBeTruthy();
    fireEvent.click(button('rtty.tx.abort'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(mocks.rtty.abort).not.toHaveBeenCalled();

    mocks.rtty.txStatus = txStatus();
    view.rerender(
      <HeroUIProvider disableAnimation><RttyTxBuffer placeholderValues={VALUES} onStop={onStop} stopped /></HeroUIProvider>,
    );
    expect(screen.getByTestId('rtty-tx-status').textContent).toContain('rtty.tx.stopped');
  });
});
