import type { CWDecoderCommitEvent, CWDecoderPendingEvent, CWDecoderCharacterSpan, CWDecoderWordSpaceSpan } from './types.js';

const FFT_LENGTH = 768;
const HOP_LENGTH = 192;
const DEFAULT_OVERLAP_RETENTION_SECONDS = 1.25;
const DEFAULT_STABLE_MIN_NON_WHITESPACE_CHARS = 5;
const DEFAULT_STABLE_REPEAT_COUNT = 3;

export interface StreamingCommitHelperOptions {
  backend: 'deepcw-onnx';
  sampleRate: number;
  minPendingSeconds: number;
  minConfirmedSeconds: number;
  tailGuardSeconds: number;
  maxSegmentSeconds: number;
  overlapRetentionSeconds?: number;
  stableMinNonWhitespaceChars?: number;
  stableRepeatCount?: number;
}

export interface StreamingDecodeLane {
  text: string;
  confidence: number;
  plainText: string;
  leadingWhitespace: boolean;
  characterSpans: CWDecoderCharacterSpan[];
  wordSpaceSpans: CWDecoderWordSpaceSpan[];
}

export interface StreamingSplitPoint {
  sample: number;
  endFrame: number;
  forced: boolean;
}

export interface StreamingCommitDecision {
  commitSample: number;
  lane: StreamingDecodeLane;
  forced: boolean;
  prependSpace: boolean;
}

export interface StreamingDecodeEvaluation {
  pendingLane: StreamingDecodeLane;
  decision: StreamingCommitDecision | null;
}

export interface StreamingCommitRetention {
  dropSamples: number;
  retainedOverlapSamples: number;
}

export interface DetailedDecodeLike {
  text: string;
  confidence: number;
  plainText?: string;
  characterSpans?: CWDecoderCharacterSpan[];
  wordSpaceSpans?: CWDecoderWordSpaceSpan[];
}

export class StreamingCommitHelper {
  private committedText = '';
  private retainedOverlapSamples = 0;
  private previousLane: StreamingDecodeLane | null = null;
  private stableCandidateText = '';
  private stableCandidateRepeat = 0;

  constructor(private options: StreamingCommitHelperOptions) {}

  updateOptions(options: StreamingCommitHelperOptions): void {
    this.options = options;
    this.retainedOverlapSamples = Math.min(this.retainedOverlapSamples, this.overlapRetentionSamples);
  }

  reset(): void {
    this.committedText = '';
    this.retainedOverlapSamples = 0;
    this.resetStableState();
  }

  resetStableState(): void {
    this.previousLane = null;
    this.stableCandidateText = '';
    this.stableCandidateRepeat = 0;
  }

  resetPendingState(): void {
    this.retainedOverlapSamples = 0;
    this.resetStableState();
  }

  get minPendingSamples(): number {
    return Math.floor(this.options.minPendingSeconds * this.options.sampleRate);
  }

  get minConfirmedSamples(): number {
    return Math.floor(this.options.minConfirmedSeconds * this.options.sampleRate);
  }

  get maxSegmentSamples(): number {
    return Math.floor(this.options.maxSegmentSeconds * this.options.sampleRate);
  }

  get tailGuardSamples(): number {
    return Math.floor(this.options.tailGuardSeconds * this.options.sampleRate);
  }

  get overlapRetentionSamples(): number {
    return Math.floor((this.options.overlapRetentionSeconds ?? DEFAULT_OVERLAP_RETENTION_SECONDS) * this.options.sampleRate);
  }

  getUnconfirmedPendingSamples(pendingLength: number): number {
    return Math.max(0, pendingLength - Math.min(this.retainedOverlapSamples, pendingLength));
  }

  getCommittedText(): string {
    return this.committedText;
  }

  normalizeResult(result: DetailedDecodeLike): StreamingDecodeLane {
    const characterSpans = result.characterSpans ?? [];
    const wordSpaceSpans = result.wordSpaceSpans ?? [];
    const plainText = result.plainText ?? result.text ?? '';
    const inputChars = Array.from(plainText);
    const leadingWhitespace = /^\s/.test(plainText);
    if (inputChars.length === 0 || inputChars.length !== characterSpans.length) {
      return {
        text: normalizeDecodedText(plainText),
        confidence: result.confidence,
        plainText,
        leadingWhitespace,
        characterSpans: [],
        wordSpaceSpans,
      };
    }

    const normalizedChars: string[] = [];
    const normalizedSpans: CWDecoderCharacterSpan[] = [];
    let pendingWhitespaceStart: number | null = null;
    let pendingWhitespaceEnd: number | null = null;

    inputChars.forEach((char, index) => {
      const span = characterSpans[index];
      if (!span) return;

      if (/\s/.test(char)) {
        if (normalizedChars.length === 0) return;
        if (pendingWhitespaceStart == null) pendingWhitespaceStart = span.startFrame;
        pendingWhitespaceEnd = span.endFrame;
        return;
      }

      if (pendingWhitespaceStart != null && pendingWhitespaceEnd != null) {
        normalizedChars.push(' ');
        normalizedSpans.push({ char: ' ', startFrame: pendingWhitespaceStart, endFrame: pendingWhitespaceEnd });
        pendingWhitespaceStart = null;
        pendingWhitespaceEnd = null;
      }

      normalizedChars.push(char);
      normalizedSpans.push({ char, startFrame: span.startFrame, endFrame: span.endFrame });
    });

    return {
      text: normalizedChars.join(''),
      confidence: result.confidence,
      plainText,
      leadingWhitespace,
      characterSpans: normalizedSpans,
      wordSpaceSpans,
    };
  }

  evaluateDecode(result: DetailedDecodeLike, analysisLength: number, pendingLength: number): StreamingDecodeEvaluation {
    const overlapOffset = Math.min(this.retainedOverlapSamples, analysisLength);
    const pendingResult = trimResultBeforeSample(result, overlapOffset);
    const pendingLane = this.normalizeResult(pendingResult);
    const fullSegment = pendingLength >= this.maxSegmentSamples;
    const minCommitSample = overlapOffset + this.minConfirmedSamples;
    const commitLimit = fullSegment
      ? analysisLength
      : Math.max(minCommitSample, analysisLength - this.tailGuardSamples);
    const stablePrefix = trimLaneToSample(commonPrefixLane(this.previousLane, pendingLane), commitLimit);
    const lastStableSample = getLaneEndSample(stablePrefix);
    const nonWhitespaceChars = countNonWhitespaceChars(stablePrefix);
    const stableText = stablePrefix.text;

    if (stableText && stableText === this.stableCandidateText) {
      this.stableCandidateRepeat += 1;
    } else if (stableText) {
      this.stableCandidateText = stableText;
      this.stableCandidateRepeat = 1;
    } else {
      this.stableCandidateText = '';
      this.stableCandidateRepeat = 0;
    }

    const stableByRepetition = hasText(stablePrefix) && this.stableCandidateRepeat >= (this.options.stableRepeatCount ?? DEFAULT_STABLE_REPEAT_COUNT);
    const stableEnough = lastStableSample != null
      && lastStableSample >= minCommitSample
      && (nonWhitespaceChars >= (this.options.stableMinNonWhitespaceChars ?? DEFAULT_STABLE_MIN_NON_WHITESPACE_CHARS) || stableByRepetition);
    const fullWithStableText = fullSegment && lastStableSample != null && hasText(stablePrefix);
    const fullWithNoStableText = fullSegment && !hasText(stablePrefix);

    if (stableEnough || fullWithStableText || fullWithNoStableText) {
      const commitSample = lastStableSample ?? analysisLength;
      const lane = lastStableSample == null ? emptyLane(pendingLane.confidence) : trimLaneToSample(stablePrefix, commitSample);
      return {
        pendingLane,
        decision: {
          commitSample,
          lane,
          forced: !stableEnough,
          prependSpace: pendingLane.leadingWhitespace,
        },
      };
    }

    this.previousLane = pendingLane;
    return { pendingLane, decision: null };
  }

  acceptCommit(commitSample: number): StreamingCommitRetention {
    const retainedOverlapSamples = Math.min(this.overlapRetentionSamples, Math.max(0, commitSample));
    this.retainedOverlapSamples = retainedOverlapSamples;
    this.resetStableState();
    return {
      dropSamples: Math.max(0, commitSample - retainedOverlapSamples),
      retainedOverlapSamples,
    };
  }

  buildPendingEvent(
    lane: StreamingDecodeLane,
    timestamp = Date.now(),
    metadata: Partial<Pick<CWDecoderPendingEvent, 'sessionId' | 'version' | 'targetFreqHz' | 'filterWidthHz'>> = {},
  ): CWDecoderPendingEvent {
    return {
      type: 'pending',
      backend: this.options.backend,
      sessionId: metadata.sessionId,
      version: metadata.version,
      text: lane.text,
      plainText: lane.plainText,
      finalized: false,
      confidence: lane.confidence,
      targetFreqHz: metadata.targetFreqHz,
      filterWidthHz: metadata.filterWidthHz,
      characterSpans: lane.characterSpans,
      wordSpaceSpans: lane.wordSpaceSpans,
      timestamp,
    };
  }

  getConfirmedSplitPoint(wordSpaceSpans: CWDecoderWordSpaceSpan[], analysisLength: number, allowNearEnd = false): StreamingSplitPoint | null {
    if (!allowNearEnd && analysisLength < this.minConfirmedSamples + this.tailGuardSamples) {
      return null;
    }
    const maxCommittedSample = allowNearEnd ? analysisLength : analysisLength - this.tailGuardSamples;

    for (let index = wordSpaceSpans.length - 1; index >= 0; index -= 1) {
      const span = wordSpaceSpans[index]!;
      const splitSample = getSpanSplitSample(span);
      if (splitSample >= this.minConfirmedSamples && splitSample <= maxCommittedSample) {
        return { sample: splitSample, endFrame: span.endFrame, forced: false };
      }
    }

    return null;
  }

  getForcedSplitPoint(analysisLength: number, pendingLength: number, wordSpaceSpans: CWDecoderWordSpaceSpan[]): StreamingSplitPoint | null {
    if (pendingLength < this.maxSegmentSamples || analysisLength <= 0) return null;
    const nearEndSplit = this.getConfirmedSplitPoint(wordSpaceSpans, analysisLength, true);
    return nearEndSplit ?? { sample: analysisLength, endFrame: Number.POSITIVE_INFINITY, forced: true };
  }

  trimLaneToFrame(result: DetailedDecodeLike, endFrame: number): StreamingDecodeLane {
    const characterSpans = (result.characterSpans ?? []).filter((span) => span.endFrame <= endFrame);
    const plainText = characterSpans.map((span) => span.char).join('');
    return this.normalizeResult({
      text: plainText,
      plainText,
      confidence: result.confidence,
      characterSpans,
      wordSpaceSpans: (result.wordSpaceSpans ?? []).filter((span) => span.endFrame <= endFrame),
    });
  }

  buildCommitEvent(
    lane: StreamingDecodeLane,
    timestamp = Date.now(),
    metadata: Partial<Pick<CWDecoderCommitEvent, 'id' | 'sessionId' | 'sequence' | 'prependSpace' | 'targetFreqHz' | 'filterWidthHz' | 'startedAt' | 'endedAt'>> = {},
  ): CWDecoderCommitEvent | null {
    const text = lane.text.trim();
    if (!text) return null;
    const prependSpace = Boolean(metadata.prependSpace);
    this.committedText = joinTranscriptText(this.committedText, text, prependSpace);
    return {
      type: 'commit',
      id: metadata.id ?? `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      backend: this.options.backend,
      sessionId: metadata.sessionId,
      sequence: metadata.sequence,
      text,
      plainText: lane.plainText,
      finalized: true,
      prependSpace,
      confidence: lane.confidence,
      timestamp,
      targetFreqHz: metadata.targetFreqHz,
      filterWidthHz: metadata.filterWidthHz,
      characterSpans: lane.characterSpans,
      wordSpaceSpans: lane.wordSpaceSpans,
      startedAt: metadata.startedAt ?? timestamp,
      endedAt: metadata.endedAt ?? timestamp,
      updatedAt: timestamp,
    };
  }
}

function getSpanSplitSample(span: CWDecoderWordSpaceSpan): number {
  const midFrame = (span.startFrame + span.endFrame) / 2;
  return Math.round(midFrame * HOP_LENGTH + FFT_LENGTH / 2);
}

function getFrameStartSample(frame: number): number {
  return frame * HOP_LENGTH;
}

function getFrameEndSample(frame: number): number {
  return frame * HOP_LENGTH + FFT_LENGTH;
}

function getSpanCenterSample(startFrame: number, endFrame: number): number {
  return Math.round((getFrameStartSample(startFrame) + getFrameEndSample(endFrame)) / 2);
}

function trimResultBeforeSample(result: DetailedDecodeLike, sample: number): DetailedDecodeLike {
  if (sample <= 0) return result;
  const characterSpans = (result.characterSpans ?? []).filter((span) => getSpanCenterSample(span.startFrame, span.endFrame) > sample);
  const plainText = characterSpans.map((span) => span.char).join('');
  return {
    text: plainText,
    plainText,
    confidence: result.confidence,
    characterSpans,
    wordSpaceSpans: (result.wordSpaceSpans ?? []).filter((span) => getSpanCenterSample(span.startFrame, span.endFrame) > sample),
  };
}

function trimLaneToSample(lane: StreamingDecodeLane, sample: number): StreamingDecodeLane {
  const characterSpans = lane.characterSpans.filter((span) => getSpanCenterSample(span.startFrame, span.endFrame) <= sample);
  const text = characterSpans.map((span) => span.char).join('');
  return {
    ...lane,
    text,
    plainText: text,
    characterSpans,
    wordSpaceSpans: lane.wordSpaceSpans.filter((span) => getSpanCenterSample(span.startFrame, span.endFrame) <= sample),
  };
}

function commonPrefixLane(previous: StreamingDecodeLane | null, current: StreamingDecodeLane): StreamingDecodeLane {
  if (!previous) return emptyLane(current.confidence);
  const previousChars = Array.from(previous.text);
  const currentChars = Array.from(current.text);
  const maxLength = Math.min(previousChars.length, currentChars.length, previous.characterSpans.length, current.characterSpans.length);
  let length = 0;
  while (length < maxLength && previousChars[length] === currentChars[length]) {
    length += 1;
  }
  const characterSpans = current.characterSpans.slice(0, length);
  const text = currentChars.slice(0, length).join('');
  return {
    text,
    confidence: current.confidence,
    plainText: text,
    leadingWhitespace: current.leadingWhitespace,
    characterSpans,
    wordSpaceSpans: current.wordSpaceSpans.filter((span) => {
      const end = characterSpans.at(-1)?.endFrame;
      return end != null && span.endFrame <= end;
    }),
  };
}

function getLaneEndSample(lane: StreamingDecodeLane): number | null {
  const lastSpan = lane.characterSpans.at(-1);
  return lastSpan ? getFrameEndSample(lastSpan.endFrame) : null;
}

function countNonWhitespaceChars(lane: StreamingDecodeLane): number {
  return lane.characterSpans.reduce((count, span) => (/\s/.test(span.char) ? count : count + 1), 0);
}

function hasText(lane: StreamingDecodeLane): boolean {
  return countNonWhitespaceChars(lane) > 0;
}

function emptyLane(confidence = 0): StreamingDecodeLane {
  return {
    text: '',
    confidence,
    plainText: '',
    leadingWhitespace: false,
    characterSpans: [],
    wordSpaceSpans: [],
  };
}

function normalizeDecodedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function joinTranscriptText(existing: string, next: string, prependSpace: boolean): string {
  if (!existing) return next;
  if (!next) return existing;
  return prependSpace ? `${existing} ${next}`.replace(/\s+/g, ' ').trim() : `${existing}${next}`.replace(/\s+/g, ' ').trim();
}
