// @vitest-environment jsdom
/**
 * Characterization tests for the CW decoder panel, rendered inside the real
 * CWDecoderProvider. Only the REST api and the WS event bus are replaced.
 */
import React from 'react';
import { EventEmitter } from 'node:events';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageStub } from './cwTestStorage';

const mocks = vi.hoisted(() => ({
  bus: null as unknown as import('node:events').EventEmitter,
  service: null as unknown,
  canControl: true,
  api: {
    getCWDecoderConfig: vi.fn(),
    getCWDecoderBackends: vi.fn(),
    startCWDecoder: vi.fn(),
    stopCWDecoder: vi.fn(),
    clearCWDecoderTranscript: vi.fn(),
    updateCWDecoderConfig: vi.fn(),
    updateCWDecoderTuning: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock('../../../store/authStore', () => ({ useCan: () => mocks.canControl }));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { isConnected: true, radioService: mocks.service } }),
}));

import { CWDecoderPanel } from '../CWDecoderPanel';
import { CWDecoderProvider } from '../../../hooks/useCWDecoder';
import { setCWQSOHisCallsign, useCWQSODraft } from '../../../store/cwQsoDraftStore';

const LISTENING_STATUS = { enabled: true, state: 'listening', active: true, running: true, updatedAt: 1 };

const ui = () => (
  <HeroUIProvider disableAnimation>
    <CWDecoderProvider><CWDecoderPanel /></CWDecoderProvider>
  </HeroUIProvider>
);

function readHisCallsign() {
  const { result, unmount } = renderHook(() => useCWQSODraft());
  const value = result.current.hisCallsign;
  unmount();
  return value;
}

async function mountRunning() {
  const view = render(ui());
  await waitFor(() => expect(mocks.api.getCWDecoderConfig).toHaveBeenCalled());
  await act(async () => {});
  act(() => { mocks.bus.emit('cwDecoderStatusChanged', { ...LISTENING_STATUS, backend: 'deepcw-onnx' }); });
  return view;
}

function emitTranscript(committed: string, pending: string) {
  const timestamp = Date.now();
  act(() => {
    mocks.bus.emit('cwDecoderEvent', { type: 'transcript_reset', sessionId: 'session-1', timestamp });
    mocks.bus.emit('cwDecoderEvent', {
      type: 'transcript_commit',
      timestamp,
      segment: { id: 'seg-1', sessionId: 'session-1', sequence: 1, text: committed, updatedAt: timestamp },
    });
    mocks.bus.emit('cwDecoderEvent', {
      type: 'transcript_pending',
      timestamp: timestamp + 1,
      pending: { sessionId: 'session-1', version: 1, text: pending, updatedAt: timestamp + 1 },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const bus = new EventEmitter();
  mocks.bus = bus;
  mocks.service = { isConnected: true, wsClientInstance: { onWSEvent: bus.on.bind(bus), offWSEvent: bus.off.bind(bus), send: vi.fn() } };
  mocks.canControl = true;
  mocks.api.getCWDecoderConfig.mockResolvedValue({ success: true, config: { enabled: false, backend: 'deepcw-onnx' } });
  mocks.api.getCWDecoderBackends.mockResolvedValue({ success: true, backends: [{ id: 'deepcw-onnx', label: 'DeepCW' }] });
  // Response shapes mirror packages/core api: { success, config, status }.
  mocks.api.clearCWDecoderTranscript.mockResolvedValue({ success: true, config: {}, status: LISTENING_STATUS });
  mocks.api.startCWDecoder.mockResolvedValue({ success: true, config: {}, status: LISTENING_STATUS });
  setCWQSOHisCallsign('');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CWDecoderPanel transcript', () => {
  it('hides the transcript while the decoder is idle', async () => {
    render(ui());
    await waitFor(() => expect(mocks.api.getCWDecoderConfig).toHaveBeenCalled());
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('starts the decoder from the enable switch', async () => {
    render(ui());
    await waitFor(() => expect(mocks.api.getCWDecoderConfig).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole('switch', { name: 'cw.decoder.enable' }));
    await waitFor(() => expect(mocks.api.startCWDecoder).toHaveBeenCalledTimes(1));
  });

  it('renders committed text followed by pending text', async () => {
    await mountRunning();
    expect(screen.getByRole('textbox').textContent).toBe('cw.decoder.pendingEmpty');
    emitTranscript('CQ DE JA1ABC', 'K');
    const transcript = screen.getByRole('textbox');
    expect(transcript.textContent).toBe('CQ DE JA1ABC K');
    expect(screen.getByText('CQ DE JA1ABC')).toBeTruthy();
    expect(screen.getByText(/^\s*K$/)).toBeTruthy();
  });

  it('also accepts committed/pending text carried by status updates', async () => {
    await mountRunning();
    act(() => { mocks.bus.emit('cwDecoderStatusChanged', { ...LISTENING_STATUS, committedText: 'TEST DE K1ABC', pendingText: 'AR' }); });
    expect(screen.getByRole('textbox').textContent).toBe('TEST DE K1ABC AR');
  });

  it('"use callsign" copies the first callsign from committed text into the CW QSO draft', async () => {
    await mountRunning();
    expect((screen.getByRole('button', { name: 'cw.decoder.noCallsign' }) as HTMLButtonElement).disabled).toBe(true);
    emitTranscript('CQ DE ja1abc', 'BG5');
    fireEvent.click(screen.getByRole('button', { name: 'cw.decoder.useCallsign' }));
    expect(readHisCallsign()).toBe('JA1ABC');
  });

  it('ignores pending-only text when looking for a callsign', async () => {
    await mountRunning();
    act(() => {
      mocks.bus.emit('cwDecoderEvent', {
        type: 'transcript_pending',
        timestamp: Date.now(),
        pending: { sessionId: 'session-1', version: 1, text: 'DE JA1ABC', updatedAt: Date.now() },
      });
    });
    expect(screen.getByRole('textbox').textContent).toBe('DE JA1ABC');
    expect((screen.getByRole('button', { name: 'cw.decoder.noCallsign' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clear empties the transcript locally and calls the decoder clear endpoint', async () => {
    await mountRunning();
    emitTranscript('CQ DE JA1ABC', 'K');
    fireEvent.click(screen.getByRole('button', { name: 'cw.decoder.clear' }));
    await waitFor(() => expect(mocks.api.clearCWDecoderTranscript).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox').textContent).toBe('cw.decoder.pendingEmpty');
    expect((screen.getByRole('button', { name: 'cw.decoder.clear' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables clear without decoder control permission', async () => {
    mocks.canControl = false;
    await mountRunning();
    emitTranscript('CQ DE JA1ABC', 'K');
    expect((screen.getByRole('button', { name: 'cw.decoder.clear' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
