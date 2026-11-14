// @vitest-environment jsdom
/**
 * RTTY context: the pure transcript reducers and the provider wiring to the
 * WebSocket client. Only the REST api, the WS client and the radio store
 * projection are replaced.
 */
import React from 'react';
import { EventEmitter } from 'node:events';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WSMessageType, type RttyDecoderEvent } from '@tx5dr/contracts';
import { chars, rttyConfig, txStatus } from '../../components/rtty/__tests__/rttyTestFixtures';

const mocks = vi.hoisted(() => ({
  bus: null as unknown as import('node:events').EventEmitter,
  send: vi.fn(),
  service: null as unknown,
  operatorId: 'op1' as string | null,
  engineMode: 'rtty',
  api: {
    getRttyState: vi.fn(),
    updateRttyConfig: vi.fn(),
    previewRttyTuning: vi.fn(),
    clearRttyTranscript: vi.fn(),
  },
}));

vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock('../../store/radioStore', () => ({
  useConnection: () => ({ state: { isConnected: true, radioService: mocks.service } }),
  useRadioModeState: () => ({ engineMode: mocks.engineMode }),
  useCurrentOperatorId: () => ({ currentOperatorId: mocks.operatorId, setCurrentOperatorId: vi.fn() }),
}));

import {
  RttyProvider,
  applyTxEcho,
  rttyTranscriptReducer,
  trimTranscript,
  useRtty,
  useRttyTranscript,
  type RttyTranscript,
} from '../useRtty';

const EMPTY: RttyTranscript = { sessionId: null, segments: [], lastSequence: -1 };

const charactersEvent = (text: string, sequence: number, sessionId = 's1'): RttyDecoderEvent => ({
  kind: 'characters',
  sessionId,
  sequence,
  characters: chars(text),
});

const segmentText = (transcript: RttyTranscript) => transcript.segments.map(segment => (
  segment.kind === 'tx'
    ? `tx:${segment.text}`
    : `${segment.kind}:${segment.characters.map(c => c.ch).join('')}`
));

describe('rttyTranscriptReducer', () => {
  it('appends consecutive characters to one rx segment and ignores replayed sequences', () => {
    let transcript = rttyTranscriptReducer(EMPTY, charactersEvent('CQ ', 0));
    transcript = rttyTranscriptReducer(transcript, charactersEvent('DE K1ABC\n', 1));
    expect(segmentText(transcript)).toEqual(['rx:CQ DE K1ABC\n']);
    expect(transcript).toMatchObject({ sessionId: 's1', lastSequence: 1 });

    const replayed = rttyTranscriptReducer(transcript, charactersEvent('CQ ', 1));
    expect(replayed).toBe(transcript);
  });

  it('a reset starts an empty transcript for the new session', () => {
    const transcript = rttyTranscriptReducer(EMPTY, charactersEvent('RYRY', 4));
    const reset = rttyTranscriptReducer(transcript, { kind: 'reset', sessionId: 's2', reason: 'cleared' });
    expect(reset).toEqual({ sessionId: 's2', segments: [], lastSequence: -1 });
    // Sequence numbering restarts in the new session.
    expect(segmentText(rttyTranscriptReducer(reset, charactersEvent('NEW', 0, 's2')))).toEqual(['rx:NEW']);
  });

  it('characters from an unseen session replace the transcript even without a reset', () => {
    const transcript = rttyTranscriptReducer(EMPTY, charactersEvent('OLD', 9, 's1'));
    const next = rttyTranscriptReducer(transcript, charactersEvent('NEW', 0, 's2'));
    expect(segmentText(next)).toEqual(['rx:NEW']);
    expect(next).toMatchObject({ sessionId: 's2', lastSequence: 0 });
  });

  it('trims the head of the oldest segment once the transcript exceeds the character limit', () => {
    let transcript = rttyTranscriptReducer(EMPTY, charactersEvent('A'.repeat(15_000), 0));
    transcript = applyTxEcho(transcript, txStatus({ sessionId: 'tx1', sentText: 'B'.repeat(4_000), startedAt: 1 }));
    transcript = rttyTranscriptReducer(transcript, charactersEvent('C'.repeat(2_000), 1));
    expect(transcript.segments.map(segment => segment.kind)).toEqual(['rx', 'tx', 'rx']);
    const head = transcript.segments[0]!;
    expect(head.kind === 'rx' && head.characters.length).toBe(14_000);
  });
});

describe('applyTxEcho', () => {
  it('interleaves TX segments with received text and updates the current session in place', () => {
    let transcript = rttyTranscriptReducer(EMPTY, charactersEvent('CQ DE JA1XYZ ', 0));
    transcript = applyTxEcho(transcript, txStatus({ active: true, sessionId: 'tx1', sentText: 'JA1', startedAt: 10 }));
    transcript = applyTxEcho(transcript, txStatus({ active: true, sessionId: 'tx1', sentText: 'JA1XYZ DE K1ABC', startedAt: 10 }));
    transcript = rttyTranscriptReducer(transcript, charactersEvent('R R ', 1));
    transcript = applyTxEcho(transcript, txStatus({ active: true, sessionId: 'tx2', sentText: 'TU', startedAt: 20 }));
    expect(segmentText(transcript)).toEqual([
      'rx:CQ DE JA1XYZ ',
      'tx:JA1XYZ DE K1ABC',
      'rx:R R ',
      'tx:TU',
    ]);
  });

  it('returns the same transcript when there is nothing new to echo', () => {
    const transcript = applyTxEcho(EMPTY, txStatus({ sessionId: 'tx1', sentText: 'HI' }));
    expect(applyTxEcho(transcript, txStatus({ sessionId: 'tx1', sentText: 'HI' }))).toBe(transcript);
    expect(applyTxEcho(transcript, txStatus({ sessionId: null, sentText: 'X' }))).toBe(transcript);
    expect(applyTxEcho(transcript, txStatus({ sessionId: 'tx2', sentText: '' }))).toBe(transcript);
  });
});

describe('RttyProvider', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => <RttyProvider>{children}</RttyProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    const bus = new EventEmitter();
    mocks.bus = bus;
    mocks.operatorId = 'op1';
    mocks.engineMode = 'rtty';
    mocks.service = {
      wsClientInstance: {
        onWSEvent: (event: string, handler: (...args: unknown[]) => void) => bus.on(event, handler),
        offWSEvent: (event: string, handler: (...args: unknown[]) => void) => bus.off(event, handler),
        send: mocks.send,
      },
    };
    mocks.api.getRttyState.mockResolvedValue({ success: true, config: rttyConfig(), txStatus: null, decoderStatus: null });
    mocks.api.clearRttyTranscript.mockResolvedValue({ success: true, status: null });
  });

  afterEach(() => {
    cleanup();
  });

  async function mount() {
    const view = renderHook(() => ({ ...useRtty(), ...useRttyTranscript() }), { wrapper });
    await waitFor(() => expect(view.result.current.config).not.toBeNull());
    return view;
  }

  it('loads the initial state and sends transmit commands with the current operator id', async () => {
    const { result } = await mount();
    expect(result.current.isRttyMode).toBe(true);
    expect(result.current.canTransmit).toBe(false);

    act(() => result.current.append('CQ', { finishAfter: true, placeholderValues: { myCall: 'K1ABC' } }));
    act(() => result.current.retract(2));
    act(() => result.current.retract(0));
    act(() => result.current.append(''));
    act(() => result.current.playMessage('K1ABC', 'slot-1', { hisCall: 'JA1XYZ' }));
    act(() => result.current.abort());

    expect(mocks.send.mock.calls).toEqual([
      [WSMessageType.RTTY_TX_APPEND, { text: 'CQ', start: undefined, finishAfter: true, placeholderValues: { myCall: 'K1ABC' }, operatorId: 'op1' }],
      [WSMessageType.RTTY_TX_RETRACT, { count: 2, operatorId: 'op1' }],
      [WSMessageType.RTTY_PLAY_MESSAGE, { callsign: 'K1ABC', slotId: 'slot-1', placeholderValues: { hisCall: 'JA1XYZ' }, operatorId: 'op1' }],
      [WSMessageType.RTTY_TX_ABORT, { operatorId: 'op1' }],
    ]);
  });

  it('applies rttyTxStatus and decoder events from the WebSocket and unsubscribes on unmount', async () => {
    const { result, unmount } = await mount();

    act(() => { mocks.bus.emit('rttyTxStatus', txStatus({ active: true, phase: 'on_air', sessionId: 'tx1', sentText: 'DE K1ABC' })); });
    expect(result.current.txStatus).toMatchObject({ active: true, phase: 'on_air' });
    expect(result.current.canTransmit).toBe(true);

    act(() => { mocks.bus.emit('rttyDecoderEvent', charactersEvent('TU', 0)); });
    expect(segmentText(result.current.transcript)).toEqual(['tx:DE K1ABC', 'rx:TU']);

    act(() => { mocks.bus.emit('rttyConfigChanged', rttyConfig({ baud: 75 })); });
    expect(result.current.config?.baud).toBe(75);

    unmount();
    expect(mocks.bus.listenerCount('rttyTxStatus')).toBe(0);
    expect(mocks.bus.listenerCount('rttyDecoderEvent')).toBe(0);
  });

  it('cannot transmit without an operator and clears the local transcript on request', async () => {
    mocks.operatorId = null;
    const { result } = await mount();
    act(() => { mocks.bus.emit('rttyTxStatus', txStatus({ sessionId: 'tx1', sentText: 'HI' })); });
    expect(result.current.canTransmit).toBe(false);
    expect(result.current.transcript.segments).toHaveLength(1);

    await act(async () => { await result.current.clearTranscript(); });
    expect(result.current.transcript.segments).toEqual([]);
    // Clearing is local: other operators keep their text, and it stays cleared.
    expect(mocks.api.clearRttyTranscript).not.toHaveBeenCalled();
    act(() => { mocks.bus.emit('rttyTxStatus', txStatus({ sessionId: 'tx1', sentText: 'HI' })); });
    expect(result.current.transcript.segments).toEqual([]);
    // Only text sent after the clear is echoed.
    act(() => { mocks.bus.emit('rttyTxStatus', txStatus({ sessionId: 'tx1', sentText: 'HI THERE' })); });
    expect(segmentText(result.current.transcript)).toEqual(['tx: THERE']);
  });
});

describe('trimTranscript', () => {
  it('keeps the newest characters when a single segment exceeds the limit', () => {
    let transcript: RttyTranscript = EMPTY;
    transcript = rttyTranscriptReducer(transcript, charactersEvent('A'.repeat(19_999), 0));
    transcript = rttyTranscriptReducer(transcript, charactersEvent('BC', 1));
    expect(transcript.segments).toHaveLength(1);
    const segment = transcript.segments[0]!;
    expect(segment.kind).toBe('rx');
    if (segment.kind === 'rx') {
      expect(segment.characters).toHaveLength(20_000);
      expect(segment.characters.slice(-2).map((c) => c.ch).join('')).toBe('BC');
    }
  });

  it('cuts the head of a straddling TX echo and drops older segments', () => {
    const segments = trimTranscript([
      { kind: 'tx', id: 'old', sessionId: 'a', text: 'OLD', startedAt: 0 },
      { kind: 'tx', id: 'big', sessionId: 'b', text: `X${'Y'.repeat(20_000)}`, startedAt: 1 },
    ]);
    expect(segments.map((segment) => segment.id)).toEqual(['big']);
    expect(segments[0]!.kind === 'tx' && segments[0]!.text).toBe('Y'.repeat(20_000));
  });
});

describe('re-decode', () => {
  it('shows a replay as a separate block and keeps the original text and TX echo', () => {
    let transcript = rttyTranscriptReducer(EMPTY, charactersEvent('XQ VE', 0));
    transcript = applyTxEcho(transcript, txStatus({ sessionId: 'tx1', sentText: 'DE K1ABC', startedAt: 5_000 }));
    transcript = rttyTranscriptReducer(transcript, {
      kind: 'characters',
      sessionId: 's1',
      sequence: 1,
      replay: true,
      replayFrom: 0,
      characters: [{ ch: 'C', confidence: 1, at: 0 }, { ch: 'Q', confidence: 1, at: 100 }],
    });
    expect(segmentText(transcript)).toEqual(['rx:XQ VE', 'tx:DE K1ABC', 'replay:CQ']);
    transcript = rttyTranscriptReducer(transcript, charactersEvent(' TU', 2));
    expect(segmentText(transcript)).toEqual(['rx:XQ VE', 'tx:DE K1ABC', 'replay:CQ', 'rx: TU']);
  });
});

describe('transcript snapshot', () => {
  const at = (text: string, start: number, sequence: number, sessionId = 's1') => ({
    kind: 'characters' as const,
    sessionId,
    sequence,
    characters: Array.from(text, (ch, index) => ({ ch, confidence: 1, at: start + index })),
  });
  const snapshot = (text: string, sequence: number) => ({ ...at(text, 0, sequence), snapshot: true });
  const text = (transcript: RttyTranscript) => segmentText(transcript).join('|');

  it('does not duplicate live text that arrived before the snapshot', () => {
    let transcript = rttyTranscriptReducer(EMPTY, at('DE JA', 3, 5));
    transcript = rttyTranscriptReducer(transcript, snapshot('CQ DE JA', 6));
    expect(text(transcript)).toBe('rx:CQ DE JA');
  });

  it('replaces text shown before a reconnect instead of appending it again', () => {
    let transcript = rttyTranscriptReducer(EMPTY, at('CQ ', 0, 0));
    transcript = rttyTranscriptReducer(transcript, snapshot('CQ DE JA1AAA', 9));
    expect(text(transcript)).toBe('rx:CQ DE JA1AAA');
    transcript = rttyTranscriptReducer(transcript, at(' K', 12, 10));
    expect(text(transcript)).toBe('rx:CQ DE JA1AAA K');
  });

  it('is applied even when live batches with higher sequences came first', () => {
    let transcript = rttyTranscriptReducer(EMPTY, at('AAA', 20, 7));
    transcript = rttyTranscriptReducer(transcript, snapshot('CQ DE JA1', 3));
    expect(text(transcript)).toBe('rx:CQ DE JA1AAA');
    expect(transcript.lastSequence).toBe(7);
  });

  it('splits long received text at word boundaries', () => {
    let transcript = EMPTY;
    for (let i = 0; i < 40; i += 1) transcript = rttyTranscriptReducer(transcript, at('RYRY TEST ', i * 10, i));
    expect(transcript.segments.length).toBeGreaterThan(1);
    for (const segment of transcript.segments.slice(0, -1)) {
      if (segment.kind === 'rx') expect(segment.characters.at(-1)?.ch).toBe(' ');
    }
  });
});

describe('snapshot after a shown replay', () => {
  it('drops replay blocks the snapshot already covers instead of showing them twice', () => {
    let transcript = rttyTranscriptReducer(EMPTY, {
      kind: 'characters', sessionId: 's1', sequence: 0,
      characters: Array.from('XQ XQ VE', (ch, index) => ({ ch, confidence: 1, at: index * 10 })),
    });
    transcript = rttyTranscriptReducer(transcript, {
      kind: 'characters', sessionId: 's1', sequence: 1, replay: true, replayFrom: 0,
      characters: Array.from('CQ CQ DE', (ch, index) => ({ ch, confidence: 1, at: index * 10 })),
    });
    transcript = rttyTranscriptReducer(transcript, {
      kind: 'characters', sessionId: 's1', sequence: 1, snapshot: true,
      characters: Array.from('CQ CQ DE', (ch, index) => ({ ch, confidence: 1, at: index * 10 })),
    });
    expect(segmentText(transcript)).toEqual(['rx:CQ CQ DE']);
  });
});
