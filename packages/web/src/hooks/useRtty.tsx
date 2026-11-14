import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { api } from '@tx5dr/core';
import {
  WSMessageType,
  type KeyboardPlaceholderValues,
  type RttyConfig,
  type RttyConfigPatch,
  type RttyDecoderEvent,
  type RttyDecoderStatus,
  type RttyReceivedCharacter,
  type RttyScanUpdate,
  type RttyTxStatus,
} from '@tx5dr/contracts';
import { useConnection, useCurrentOperatorId, useRadioModeState } from '../store/radioStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('useRtty');

/** Characters kept in the terminal before the oldest segments are dropped. */
const TRANSCRIPT_LIMIT = 20_000;

export type RttyTranscriptSegment =
  | { kind: 'rx'; id: string; characters: RttyReceivedCharacter[] }
  | { kind: 'tx'; id: string; sessionId: string; text: string; startedAt: number }
  /** Re-decoded recent audio after a tuning change, shown apart from the original text. */
  | { kind: 'replay'; id: string; characters: RttyReceivedCharacter[]; replayFrom: number };

export interface RttyTranscript {
  sessionId: string | null;
  segments: RttyTranscriptSegment[];
  /** Highest RX sequence applied, to ignore replays. */
  lastSequence: number;
  /** Text before this time (server ms) was cleared locally and is not shown again. */
  clearedAt?: number;
  /** TX echo already cleared: sent text of `sessionId` up to and including `tail`. */
  clearedTx?: { sessionId: string; tail: string };
}

interface RttyState {
  config: RttyConfig | null;
  txStatus: RttyTxStatus | null;
  decoderStatus: RttyDecoderStatus | null;
  scan: RttyScanUpdate | null;
  transcript: RttyTranscript;
}

type RttyAction =
  | { type: 'config'; config: RttyConfig }
  | { type: 'txStatus'; status: RttyTxStatus }
  | { type: 'decoderStatus'; status: RttyDecoderStatus }
  | { type: 'decoderEvent'; event: RttyDecoderEvent }
  | { type: 'scan'; update: RttyScanUpdate }
  | { type: 'clearLocal' };

const EMPTY_TRANSCRIPT: RttyTranscript = { sessionId: null, segments: [], lastSequence: -1 };

/** About one character at 45.45 Bd. */
const CLEAR_MARGIN_MS = 170;
const CLEAR_TAIL_CHARACTERS = 48;

/** Received text is split into segments of about this size (at word boundaries). */
const SEGMENT_SPLIT_CHARACTERS = 256;

/** Index after the last whitespace (a word boundary), or -1. */
function lastBoundary(characters: RttyReceivedCharacter[]): number {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const ch = characters[index - 1]!.ch;
    if (ch === ' ' || ch === '\n') return index;
  }
  return -1;
}

let segmentCounter = 0;
const nextSegmentId = () => `seg-${++segmentCounter}`;

const segmentLength = (segment: RttyTranscriptSegment) => (
  segment.kind === 'tx' ? segment.text.length : segment.characters.length
);

/**
 * Keeps the newest TRANSCRIPT_LIMIT characters: whole older segments are
 * dropped and the oldest kept segment loses its head when it straddles the limit.
 */
export function trimTranscript(segments: RttyTranscriptSegment[]): RttyTranscriptSegment[] {
  let total = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const length = segmentLength(segment);
    if (total + length > TRANSCRIPT_LIMIT) {
      const keep = TRANSCRIPT_LIMIT - total;
      const kept = segments.slice(index + 1);
      if (keep <= 0) return kept;
      const head: RttyTranscriptSegment = segment.kind === 'tx'
        ? { ...segment, text: segment.text.slice(length - keep) }
        : { ...segment, characters: segment.characters.slice(length - keep) };
      return [head, ...kept];
    }
    total += length;
  }
  return segments;
}

/** Merges snapshot characters into the kept segments by time (TX echo and replay blocks stay whole). */
function mergeReplay(segments: RttyTranscriptSegment[], characters: RttyReceivedCharacter[]): RttyTranscriptSegment[] {
  type Item = { at: number; order: number; block?: Exclude<RttyTranscriptSegment, { kind: 'rx' }>; character?: RttyReceivedCharacter };
  const items: Item[] = [];
  let order = 0;
  for (const segment of segments) {
    if (segment.kind === 'tx') items.push({ at: segment.startedAt, order: order++, block: segment });
    else if (segment.kind === 'replay') items.push({ at: segment.characters.at(-1)?.at ?? segment.replayFrom, order: order++, block: segment });
    else for (const character of segment.characters) items.push({ at: character.at, order: order++, character });
  }
  for (const character of characters) items.push({ at: character.at, order: order++, character });
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  const merged: RttyTranscriptSegment[] = [];
  let pending: RttyReceivedCharacter[] = [];
  const flush = () => {
    if (pending.length > 0) merged.push({ kind: 'rx', id: nextSegmentId(), characters: pending });
    pending = [];
  };
  for (const item of items) {
    if (item.block) {
      flush();
      merged.push(item.block);
    } else if (item.character) {
      pending.push(item.character);
    }
  }
  flush();
  return merged;
}

export function rttyTranscriptReducer(transcript: RttyTranscript, event: RttyDecoderEvent): RttyTranscript {
  const clearedAt = transcript.clearedAt;
  const clearedTx = transcript.clearedTx;
  if (event.kind === 'characters' && clearedAt !== undefined) {
    const characters = event.characters.filter((character) => character.at >= clearedAt);
    if (characters.length === 0) {
      return event.sessionId === transcript.sessionId || transcript.sessionId === null
        ? { ...transcript, sessionId: event.sessionId, lastSequence: Math.max(transcript.lastSequence, event.sequence) }
        : transcript;
    }
    if (characters.length !== event.characters.length) event = { ...event, characters };
  }
  if (event.kind === 'characters' && event.snapshot) {
    // The session's text so far: it replaces what is shown up to its last
    // character, whether live batches arrived before or after it.
    const sameSession = transcript.sessionId === event.sessionId;
    const end = event.characters.reduce((latest, character) => Math.max(latest, character.at), -Infinity);
    const kept = sameSession
      ? transcript.segments
        .map((segment) => (segment.kind === 'rx'
          ? { ...segment, characters: segment.characters.filter((character) => character.at > end) }
          : segment))
        // The snapshot already contains the corrected text of earlier replay blocks.
        .filter((segment) => (segment.kind === 'tx'
          ? true
          : segment.kind === 'replay'
            ? (segment.characters.at(-1)?.at ?? segment.replayFrom) > end
            : segment.characters.length > 0))
      : transcript.segments.filter((segment) => segment.kind === 'tx');
    return {
      sessionId: event.sessionId,
      segments: trimTranscript(mergeReplay(kept, event.characters)),
      lastSequence: Math.max(sameSession ? transcript.lastSequence : -1, event.sequence),
      clearedAt,
      clearedTx,
    };
  }
  if (event.kind === 'reset') {
    return { sessionId: event.sessionId, segments: [], lastSequence: -1, clearedAt, clearedTx };
  }
  if (transcript.sessionId !== null && transcript.sessionId !== event.sessionId) {
    // A new receive session started without us seeing the reset.
    transcript = { sessionId: event.sessionId, segments: [], lastSequence: -1, clearedAt, clearedTx };
  }
  if (event.sequence <= transcript.lastSequence) return transcript;
  if (event.replay) {
    // Shown as its own block after what is already on screen; the original stays.
    const block: RttyTranscriptSegment = {
      kind: 'replay',
      id: nextSegmentId(),
      characters: event.characters,
      replayFrom: event.replayFrom ?? event.characters[0]?.at ?? 0,
    };
    return {
      sessionId: event.sessionId,
      segments: trimTranscript([...transcript.segments, block]),
      lastSequence: event.sequence,
      clearedAt,
      clearedTx,
    };
  }
  const segments = transcript.segments.slice();
  const last = segments[segments.length - 1];
  if (last?.kind === 'rx') {
    const characters = [...last.characters, ...event.characters];
    // Close long segments at a word boundary so finished text stays memoised.
    const split = characters.length > SEGMENT_SPLIT_CHARACTERS ? lastBoundary(characters) : -1;
    if (split > 0) {
      segments[segments.length - 1] = { ...last, characters: characters.slice(0, split) };
      segments.push({ kind: 'rx', id: nextSegmentId(), characters: characters.slice(split) });
    } else {
      segments[segments.length - 1] = { ...last, characters };
    }
  } else {
    segments.push({ kind: 'rx', id: nextSegmentId(), characters: event.characters });
  }
  return { sessionId: event.sessionId, segments: trimTranscript(segments), lastSequence: event.sequence, clearedAt, clearedTx };
}

/** Mirrors the text of the current transmission into the terminal as a TX segment. */
export function applyTxEcho(transcript: RttyTranscript, status: RttyTxStatus): RttyTranscript {
  if (!status.sessionId || !status.sentText) return transcript;
  // Sent text is a sliding window: find where the cleared part ends by its tail.
  let text = status.sentText;
  if (transcript.clearedTx?.sessionId === status.sessionId) {
    const at = status.sentText.lastIndexOf(transcript.clearedTx.tail);
    if (at >= 0) text = status.sentText.slice(at + transcript.clearedTx.tail.length);
  }
  if (!text) return transcript;
  const segments = transcript.segments.slice();
  const index = segments.findIndex((segment) => segment.kind === 'tx' && segment.sessionId === status.sessionId);
  if (index >= 0) {
    const existing = segments[index] as Extract<RttyTranscriptSegment, { kind: 'tx' }>;
    if (existing.text === text) return transcript;
    segments[index] = { ...existing, text };
  } else {
    segments.push({
      kind: 'tx',
      id: nextSegmentId(),
      sessionId: status.sessionId,
      text,
      startedAt: status.startedAt ?? Date.now(),
    });
  }
  return { ...transcript, segments: trimTranscript(segments) };
}

function reducer(state: RttyState, action: RttyAction): RttyState {
  switch (action.type) {
    case 'config':
      return { ...state, config: action.config };
    case 'txStatus':
      return { ...state, txStatus: action.status, transcript: applyTxEcho(state.transcript, action.status) };
    case 'decoderStatus': {
      const transcript = state.transcript.sessionId && state.transcript.sessionId !== action.status.sessionId
        ? { ...EMPTY_TRANSCRIPT, sessionId: action.status.sessionId, clearedAt: state.transcript.clearedAt, clearedTx: state.transcript.clearedTx }
        : state.transcript.sessionId ? state.transcript : { ...state.transcript, sessionId: action.status.sessionId };
      return { ...state, decoderStatus: action.status, transcript };
    }
    case 'decoderEvent':
      return { ...state, transcript: rttyTranscriptReducer(state.transcript, action.event) };
    case 'scan':
      return { ...state, scan: action.update };
    case 'clearLocal': {
      // Clear this view only. Server times: hide everything up to the newest text shown.
      let newest = 0;
      for (const segment of state.transcript.segments) {
        if (segment.kind !== 'tx') for (const character of segment.characters) newest = Math.max(newest, character.at);
      }
      const status = state.txStatus;
      return {
        ...state,
        transcript: {
          ...EMPTY_TRANSCRIPT,
          sessionId: state.transcript.sessionId,
          lastSequence: state.transcript.lastSequence,
          // A re-decoded character may carry a slightly different time than its live twin.
          clearedAt: Math.max(state.transcript.clearedAt ?? 0, newest + CLEAR_MARGIN_MS),
          clearedTx: status?.sessionId && status.sentText
            ? { sessionId: status.sessionId, tail: status.sentText.slice(-CLEAR_TAIL_CHARACTERS) }
            : state.transcript.clearedTx,
        },
      };
    }
  }
}

export interface RttyContextValue extends Omit<RttyState, 'transcript' | 'scan'> {
  isRttyMode: boolean;
  canTransmit: boolean;
  /** Appends text to the transmit buffer; starts a transmission unless `start` is false. */
  append: (text: string, options?: { start?: boolean; finishAfter?: boolean; placeholderValues?: KeyboardPlaceholderValues }) => void;
  retract: (count: number) => void;
  finish: () => void;
  abort: () => void;
  /** Plays a macro; `repeat: true` loops it (e.g. CQ) until answered, `false` stops that loop. */
  playMessage: (callsign: string, slotId: string, placeholderValues?: KeyboardPlaceholderValues, options?: { repeat?: boolean }) => void;
  updateConfig: (patch: RttyConfigPatch) => Promise<void>;
  previewTuning: (centerHz: number) => void;
}

export interface RttyTranscriptContextValue {
  transcript: RttyTranscript;
  clearTranscript: () => Promise<void>;
}

const RttyContext = createContext<RttyContextValue | null>(null);
/** Separate so that ~10 decode events per second only re-render the terminal. */
const RttyTranscriptContext = createContext<RttyTranscriptContextValue | null>(null);
/** Signal browser updates (~2/s) are likewise kept out of the main context. */
const RttyScanContext = createContext<RttyScanUpdate | null>(null);

export interface RttyProviderProps {
  /** Subscribe to the server; App keeps the provider mounted and enables it in RTTY mode. */
  enabled?: boolean;
  children: ReactNode;
}

export function RttyProvider({ enabled = true, children }: RttyProviderProps) {
  const connection = useConnection();
  const { engineMode } = useRadioModeState();
  const { currentOperatorId } = useCurrentOperatorId();
  const radioService = connection.state.radioService;
  const [state, dispatch] = useReducer(reducer, {
    config: null,
    txStatus: null,
    decoderStatus: null,
    scan: null,
    transcript: EMPTY_TRANSCRIPT,
  });

  useEffect(() => {
    if (!radioService || !enabled) return;
    const ws = radioService.wsClientInstance;
    // Slices already pushed over WS are newer than the HTTP snapshot.
    const pushed = { tx: false, config: false, decoder: false, scan: false };
    const onTx = (status: RttyTxStatus) => { pushed.tx = true; dispatch({ type: 'txStatus', status }); };
    const onConfig = (config: RttyConfig) => { pushed.config = true; dispatch({ type: 'config', config }); };
    const onDecoderStatus = (status: RttyDecoderStatus) => { pushed.decoder = true; dispatch({ type: 'decoderStatus', status }); };
    const onDecoderEvent = (event: RttyDecoderEvent) => { pushed.decoder = true; dispatch({ type: 'decoderEvent', event }); };
    const onScan = (update: RttyScanUpdate) => { pushed.scan = true; dispatch({ type: 'scan', update }); };
    ws.onWSEvent('rttyTxStatus', onTx);
    ws.onWSEvent('rttyConfigChanged', onConfig);
    ws.onWSEvent('rttyDecoderStatus', onDecoderStatus);
    ws.onWSEvent('rttyDecoderEvent', onDecoderEvent);
    ws.onWSEvent('rttyScanUpdate', onScan);
    let cancelled = false;
    api.getRttyState().then((response) => {
      if (cancelled) return;
      if (!pushed.config) dispatch({ type: 'config', config: response.config });
      if (response.txStatus && !pushed.tx) dispatch({ type: 'txStatus', status: response.txStatus });
      if (response.decoderStatus && !pushed.decoder) dispatch({ type: 'decoderStatus', status: response.decoderStatus });
      if (response.scan && !pushed.scan) dispatch({ type: 'scan', update: response.scan });
      // Text received before this client joined; sequence numbers drop duplicates.
      if (response.transcript) dispatch({ type: 'decoderEvent', event: response.transcript });
    }).catch((error: unknown) => logger.warn('Failed to load RTTY state', error));
    return () => {
      cancelled = true;
      ws.offWSEvent('rttyTxStatus', onTx);
      ws.offWSEvent('rttyConfigChanged', onConfig);
      ws.offWSEvent('rttyDecoderStatus', onDecoderStatus);
      ws.offWSEvent('rttyDecoderEvent', onDecoderEvent);
      ws.offWSEvent('rttyScanUpdate', onScan);
    };
  }, [enabled, radioService]);

  const send = useCallback((type: WSMessageType, data: Record<string, unknown>) => {
    if (!radioService) return;
    radioService.wsClientInstance.send(type, { ...data, operatorId: currentOperatorId || undefined });
  }, [currentOperatorId, radioService]);

  const append = useCallback<RttyContextValue['append']>((text, options = {}) => {
    if (!text) return;
    send(WSMessageType.RTTY_TX_APPEND, {
      text,
      start: options.start,
      finishAfter: options.finishAfter,
      placeholderValues: options.placeholderValues,
    });
  }, [send]);

  const retract = useCallback((count: number) => {
    if (count > 0) send(WSMessageType.RTTY_TX_RETRACT, { count });
  }, [send]);

  const finish = useCallback(() => send(WSMessageType.RTTY_TX_FINISH, {}), [send]);
  const abort = useCallback(() => send(WSMessageType.RTTY_TX_ABORT, {}), [send]);

  const playMessage = useCallback<RttyContextValue['playMessage']>((callsign, slotId, placeholderValues, options) => {
    send(WSMessageType.RTTY_PLAY_MESSAGE, { callsign, slotId, placeholderValues, repeat: options?.repeat });
  }, [send]);

  const updateConfig = useCallback(async (patch: RttyConfigPatch) => {
    const response = await api.updateRttyConfig(patch);
    dispatch({ type: 'config', config: response.config });
  }, []);

  const previewTuning = useCallback((centerHz: number) => {
    void api.previewRttyTuning(centerHz).catch((error: unknown) => logger.warn('RTTY tuning preview failed', error));
  }, []);

  /** Clears this client's view only; other operators keep their text. */
  const clearTranscript = useCallback(async () => {
    dispatch({ type: 'clearLocal' });
  }, []);

  const { config, txStatus, decoderStatus, transcript, scan } = state;
  const value = useMemo<RttyContextValue>(() => ({
    config,
    txStatus,
    decoderStatus,
    isRttyMode: engineMode === 'rtty',
    canTransmit: Boolean(txStatus?.available) && Boolean(currentOperatorId),
    append,
    retract,
    finish,
    abort,
    playMessage,
    updateConfig,
    previewTuning,
  }), [abort, append, config, currentOperatorId, decoderStatus, engineMode, finish, playMessage, previewTuning, retract, txStatus, updateConfig]);
  const transcriptValue = useMemo<RttyTranscriptContextValue>(
    () => ({ transcript, clearTranscript }),
    [clearTranscript, transcript],
  );

  return (
    <RttyContext.Provider value={value}>
      <RttyTranscriptContext.Provider value={transcriptValue}>
        <RttyScanContext.Provider value={scan}>{children}</RttyScanContext.Provider>
      </RttyTranscriptContext.Provider>
    </RttyContext.Provider>
  );
}

export function useRtty(): RttyContextValue {
  const value = useContext(RttyContext);
  if (!value) throw new Error('useRtty must be used inside RttyProvider');
  return value;
}

export function useRttyTranscript(): RttyTranscriptContextValue {
  const value = useContext(RttyTranscriptContext);
  if (!value) throw new Error('useRttyTranscript must be used inside RttyProvider');
  return value;
}

/** Signals found across the passband (null until the server reports). */
export function useRttyScan(): RttyScanUpdate | null {
  return useContext(RttyScanContext);
}
