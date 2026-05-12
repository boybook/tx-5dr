export interface CWDecoderTranscriptSegment {
  id: string;
  sessionId: string;
  sequence: number;
  text: string;
  plainText?: string;
  finalized: true;
  prependSpace: boolean;
  confidence?: number;
  targetFreqHz?: number;
  filterWidthHz?: number;
  characterSpans?: unknown[];
  wordSpaceSpans?: unknown[];
  startedAt?: number;
  endedAt?: number | null;
  updatedAt: number;
  raw?: unknown;
}

export interface CWDecoderPendingSegment {
  sessionId: string;
  version: number;
  text: string;
  plainText?: string;
  finalized: false;
  confidence?: number;
  targetFreqHz?: number;
  filterWidthHz?: number;
  characterSpans?: unknown[];
  wordSpaceSpans?: unknown[];
  updatedAt: number;
  raw?: unknown;
}

export interface CWDecoderTranscriptState {
  sessionId: string | null;
  segments: CWDecoderTranscriptSegment[];
  pending: CWDecoderPendingSegment | null;
  updatedAt: number;
}

export type CWDecoderTranscriptAction =
  | { type: 'reset'; sessionId: string; timestamp?: number }
  | { type: 'pending'; pending: CWDecoderPendingSegment | null; timestamp?: number }
  | { type: 'commit'; segment: CWDecoderTranscriptSegment; timestamp?: number }
  | { type: 'legacy_pending'; text: string; confidence?: number; timestamp?: number; raw?: unknown }
  | { type: 'legacy_commit'; segment?: Partial<CWDecoderTranscriptSegment>; text: string; confidence?: number; timestamp?: number; raw?: unknown }
  | { type: 'status_text'; pendingText?: string; committedText?: string; timestamp?: number }
  | { type: 'clear'; timestamp?: number };

export const EMPTY_CW_DECODER_TRANSCRIPT: CWDecoderTranscriptState = {
  sessionId: null,
  segments: [],
  pending: null,
  updatedAt: 0,
};

const MAX_TRANSCRIPT_SEGMENTS = 1000;
const LEGACY_STATUS_SESSION_ID = 'legacy-status';
const LEGACY_EVENT_SESSION_ID = 'legacy-events';

export function cwDecoderTranscriptReducer(
  state: CWDecoderTranscriptState,
  action: CWDecoderTranscriptAction,
): CWDecoderTranscriptState {
  switch (action.type) {
    case 'reset':
      return {
        sessionId: action.sessionId,
        segments: [],
        pending: null,
        updatedAt: action.timestamp ?? Date.now(),
      };
    case 'pending':
      return reducePending(state, action.pending, action.timestamp);
    case 'commit':
      return reduceCommit(state, action.segment, action.timestamp);
    case 'legacy_pending':
      if (state.sessionId && !isLegacySession(state.sessionId)) return state;
      return reducePending(state, {
        sessionId: state.sessionId ?? LEGACY_EVENT_SESSION_ID,
        version: action.timestamp ?? Date.now(),
        text: action.text,
        finalized: false,
        confidence: action.confidence,
        updatedAt: action.timestamp ?? Date.now(),
        raw: action.raw,
      }, action.timestamp);
    case 'legacy_commit':
      if (state.sessionId && !isLegacySession(state.sessionId)) return state;
      return reduceCommit(state, normalizeLegacyCommit(state, action), action.timestamp);
    case 'status_text':
      return reduceStatusText(state, action);
    case 'clear':
      return {
        sessionId: null,
        segments: [],
        pending: null,
        updatedAt: action.timestamp ?? Date.now(),
      };
    default:
      return state;
  }
}

export function deriveCWDecoderConfirmedText(segments: CWDecoderTranscriptSegment[]): string {
  let text = '';
  for (const segment of segments) {
    const segmentText = segment.text.trim();
    if (!segmentText) continue;
    if (!text) {
      text = segmentText;
      continue;
    }
    text = segment.prependSpace ? `${text} ${segmentText}` : `${text}${segmentText}`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function reducePending(
  state: CWDecoderTranscriptState,
  pending: CWDecoderPendingSegment | null,
  timestamp = Date.now(),
): CWDecoderTranscriptState {
  if (!pending) {
    return {
      ...state,
      pending: null,
      updatedAt: timestamp,
    };
  }

  const replacingLegacy = state.sessionId != null && isLegacySession(state.sessionId) && !isLegacySession(pending.sessionId);
  if (state.sessionId && pending.sessionId !== state.sessionId && !replacingLegacy) {
    return state;
  }
  if (!replacingLegacy && state.pending && state.pending.sessionId === pending.sessionId && pending.version <= state.pending.version) {
    return state;
  }

  return {
    sessionId: replacingLegacy ? pending.sessionId : state.sessionId ?? pending.sessionId,
    segments: replacingLegacy ? [] : state.segments,
    pending,
    updatedAt: pending.updatedAt || timestamp,
  };
}

function reduceCommit(
  state: CWDecoderTranscriptState,
  segment: CWDecoderTranscriptSegment,
  timestamp = Date.now(),
): CWDecoderTranscriptState {
  const replacingLegacy = state.sessionId != null && isLegacySession(state.sessionId) && !isLegacySession(segment.sessionId);
  if (state.sessionId && segment.sessionId !== state.sessionId && !replacingLegacy) {
    return state;
  }

  const sessionId = replacingLegacy ? segment.sessionId : state.sessionId ?? segment.sessionId;
  const currentSegments = replacingLegacy ? [] : state.segments;
  const duplicate = currentSegments.some(existing => (
    existing.id === segment.id || (existing.sessionId === segment.sessionId && existing.sequence === segment.sequence)
  ));
  if (duplicate) return state;

  return {
    sessionId,
    segments: [...currentSegments, segment].slice(-MAX_TRANSCRIPT_SEGMENTS),
    pending: null,
    updatedAt: segment.updatedAt || timestamp,
  };
}

function isLegacySession(sessionId: string): boolean {
  return sessionId === LEGACY_STATUS_SESSION_ID || sessionId === LEGACY_EVENT_SESSION_ID;
}

function reduceStatusText(
  state: CWDecoderTranscriptState,
  action: Extract<CWDecoderTranscriptAction, { type: 'status_text' }>): CWDecoderTranscriptState {
  if (state.sessionId && state.sessionId !== LEGACY_STATUS_SESSION_ID) {
    return state;
  }

  const timestamp = action.timestamp ?? Date.now();
  const committedText = action.committedText?.trim() ?? '';
  const pendingText = action.pendingText ?? '';
  const segments = committedText ? [makeSegment({
    id: `${LEGACY_STATUS_SESSION_ID}-0`,
    sessionId: LEGACY_STATUS_SESSION_ID,
    sequence: 0,
    text: committedText,
    confidence: undefined,
    timestamp,
    prependSpace: true,
    raw: action,
  })] : [];
  const pending = pendingText ? {
    sessionId: LEGACY_STATUS_SESSION_ID,
    version: timestamp,
    text: pendingText,
    finalized: false as const,
    updatedAt: timestamp,
    raw: action,
  } : null;

  if (segments.length === 0 && !pending) {
    return {
      sessionId: null,
      segments: [],
      pending: null,
      updatedAt: timestamp,
    };
  }

  return {
    sessionId: LEGACY_STATUS_SESSION_ID,
    segments,
    pending,
    updatedAt: timestamp,
  };
}

function normalizeLegacyCommit(
  state: CWDecoderTranscriptState,
  action: Extract<CWDecoderTranscriptAction, { type: 'legacy_commit' }>,
): CWDecoderTranscriptSegment {
  const timestamp = action.timestamp ?? action.segment?.updatedAt ?? Date.now();
  const lastSequence = state.segments.at(-1)?.sequence ?? 0;
  return makeSegment({
    id: action.segment?.id ?? `${LEGACY_EVENT_SESSION_ID}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: action.segment?.sessionId ?? state.sessionId ?? LEGACY_EVENT_SESSION_ID,
    sequence: action.segment?.sequence ?? lastSequence + 1,
    text: action.text,
    plainText: action.segment?.plainText,
    confidence: action.segment?.confidence ?? action.confidence,
    timestamp,
    prependSpace: action.segment?.prependSpace ?? true,
    raw: action.raw,
  });
}

function makeSegment(input: {
  id: string;
  sessionId: string;
  sequence: number;
  text: string;
  plainText?: string;
  confidence?: number;
  timestamp: number;
  prependSpace: boolean;
  raw?: unknown;
}): CWDecoderTranscriptSegment {
  return {
    id: input.id,
    sessionId: input.sessionId,
    sequence: input.sequence,
    text: input.text,
    plainText: input.plainText,
    finalized: true,
    prependSpace: input.prependSpace,
    confidence: input.confidence,
    startedAt: input.timestamp,
    endedAt: input.timestamp,
    updatedAt: input.timestamp,
    raw: input.raw,
  };
}
