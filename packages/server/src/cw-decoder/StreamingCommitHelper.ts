import type { CWDecoderCommitEvent, CWDecoderPendingEvent, CWDecoderCharacterSpan, CWDecoderWordSpaceSpan } from './types.js';

const FFT_LENGTH = 768;
const HOP_LENGTH = 192;

export interface StreamingCommitHelperOptions {
  backend: 'deepcw-onnx';
  sampleRate: number;
  minPendingSeconds: number;
  minConfirmedSeconds: number;
  tailGuardSeconds: number;
  maxSegmentSeconds: number;
}

export interface StreamingDecodeLane {
  text: string;
  confidence: number;
  characterSpans: CWDecoderCharacterSpan[];
  wordSpaceSpans: CWDecoderWordSpaceSpan[];
}

export interface StreamingSplitPoint {
  sample: number;
  endFrame: number;
  forced: boolean;
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

  constructor(private options: StreamingCommitHelperOptions) {}

  updateOptions(options: StreamingCommitHelperOptions): void {
    this.options = options;
  }

  reset(): void {
    this.committedText = '';
  }

  get minPendingSamples(): number {
    return Math.floor(this.options.minPendingSeconds * this.options.sampleRate);
  }

  get maxSegmentSamples(): number {
    return Math.floor(this.options.maxSegmentSeconds * this.options.sampleRate);
  }

  getCommittedText(): string {
    return this.committedText;
  }

  normalizeResult(result: DetailedDecodeLike): StreamingDecodeLane {
    const characterSpans = result.characterSpans ?? [];
    const wordSpaceSpans = result.wordSpaceSpans ?? [];
    const inputChars = Array.from(result.plainText ?? result.text ?? '');
    if (inputChars.length === 0 || inputChars.length !== characterSpans.length) {
      return {
        text: normalizeDecodedText(result.plainText ?? result.text ?? ''),
        confidence: result.confidence,
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
      characterSpans: normalizedSpans,
      wordSpaceSpans,
    };
  }

  buildPendingEvent(lane: StreamingDecodeLane, timestamp = Date.now()): CWDecoderPendingEvent {
    return {
      type: 'pending',
      backend: this.options.backend,
      text: lane.text,
      confidence: lane.confidence,
      timestamp,
    };
  }

  getConfirmedSplitPoint(wordSpaceSpans: CWDecoderWordSpaceSpan[], analysisLength: number, allowNearEnd = false): StreamingSplitPoint | null {
    const minConfirmedSamples = Math.floor(this.options.minConfirmedSeconds * this.options.sampleRate);
    const tailGuardSamples = Math.floor(this.options.tailGuardSeconds * this.options.sampleRate);
    if (!allowNearEnd && analysisLength < minConfirmedSamples + tailGuardSamples) {
      return null;
    }
    const maxCommittedSample = allowNearEnd ? analysisLength : analysisLength - tailGuardSamples;

    for (let index = wordSpaceSpans.length - 1; index >= 0; index -= 1) {
      const span = wordSpaceSpans[index]!;
      const splitSample = getSpanSplitSample(span);
      if (splitSample >= minConfirmedSamples && splitSample <= maxCommittedSample) {
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

  buildCommitEvent(lane: StreamingDecodeLane, timestamp = Date.now()): CWDecoderCommitEvent | null {
    const text = lane.text.trim();
    if (!text) return null;
    this.committedText = joinTranscriptText(this.committedText, text);
    return {
      type: 'commit',
      id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      backend: this.options.backend,
      text,
      confidence: lane.confidence,
      timestamp,
      characterSpans: lane.characterSpans,
      wordSpaceSpans: lane.wordSpaceSpans,
    };
  }
}

function getSpanSplitSample(span: CWDecoderWordSpaceSpan): number {
  const midFrame = (span.startFrame + span.endFrame) / 2;
  return Math.round(midFrame * HOP_LENGTH + FFT_LENGTH / 2);
}

function normalizeDecodedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function joinTranscriptText(existing: string, next: string): string {
  if (!existing) return next;
  if (!next) return existing;
  return `${existing} ${next}`.replace(/\s+/g, ' ').trim();
}
