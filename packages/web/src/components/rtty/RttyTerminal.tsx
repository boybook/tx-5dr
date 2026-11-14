import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faAnglesDown, faBroom, faChevronDown, faGear, faSatelliteDish } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { RttyReceivedCharacter } from '@tx5dr/contracts';
import { useRtty, useRttyTranscript, type RttyTranscriptSegment } from '../../hooks/useRtty';
import { useCan } from '../../store/authStore';
import { describeRttyError } from './rttyErrors';
import { useWorkedStatus, useWorkedCallsignContext } from './useWorkedCallsigns';
import { RTTY_CALLSIGN_RE, RTTY_REPORT_RE, isOwnCallsign } from './rttyText';
import { focusRttyTxBuffer } from './rttyFocus';
import { focusRttyCallsign } from './rttyQsoActions';
import { RttyReceiveControls } from './RttyReceiveControls';
import { RttySignalBrowser } from './RttySignalBrowser';
import { useCurrentOperatorId, useOperators } from '../../store/radioStore';

const STICKY_BOTTOM_PX = 24;

export interface RttyTerminalProps {
  onCallsign?: (callsign: string) => void;
  onReport?: (report: string) => void;
  onOpenSettings?: () => void;
  className?: string;
}

interface Word {
  text: string;
  confidence: number;
  whitespace: string;
}

/** Splits received characters into words with mean confidence, keeping whitespace runs. */
export function groupReceivedWords(characters: RttyReceivedCharacter[]): Word[] {
  const words: Word[] = [];
  let text = '';
  let sum = 0;
  let whitespace = '';
  const flush = () => {
    if (text || whitespace) {
      words.push({ text, confidence: text ? sum / text.length : 1, whitespace });
    }
    text = '';
    sum = 0;
    whitespace = '';
  };
  for (const character of characters) {
    const isSpace = character.ch === ' ' || character.ch === '\n';
    if (isSpace) {
      whitespace += character.ch;
    } else {
      if (whitespace) flush();
      text += character.ch;
      sum += character.confidence;
    }
  }
  flush();
  return words;
}

/** Report-like tokens (5NN, 599, serials) take precedence over the callsign pattern. */
export function classifyWord(word: Pick<Word, 'text' | 'confidence'>): 'callsign' | 'report' | 'text' {
  if (!word.text) return 'text';
  if (RTTY_REPORT_RE.test(word.text)) return 'report';
  if (word.confidence >= 0.45 && RTTY_CALLSIGN_RE.test(word.text)) return 'callsign';
  return 'text';
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.7) return 'text-foreground';
  if (confidence >= 0.5) return 'text-foreground/80';
  if (confidence >= 0.35) return 'text-foreground/60';
  return 'text-default-400';
}

function confidenceOpacity(confidence: number): string {
  if (confidence >= 0.7) return '';
  if (confidence >= 0.5) return 'opacity-80';
  return 'opacity-60';
}

/** A clickable callsign, styled by whether it is already in the log. */
function CallsignButton({ callsign, confidence, onCallsign }: {
  callsign: string;
  confidence: number;
  onCallsign: (callsign: string) => void;
}) {
  const { t } = useTranslation('radio');
  const status = useWorkedStatus(callsign);
  const style = status === 'dupe'
    ? 'text-default-500 line-through decoration-default-400'
    : status === 'worked'
      ? 'text-primary underline decoration-dotted decoration-primary/60'
      : 'text-primary underline decoration-primary/40';
  const hint = status === 'dupe'
    ? t('rtty.terminal.workedDupe', 'Already worked on this band')
    : status === 'worked'
      ? t('rtty.terminal.workedBefore', 'Worked before')
      : status === 'new' ? t('rtty.terminal.workedNew', 'Not in the log') : null;
  const title = t('rtty.terminal.useCallsign', 'Use {{callsign}} as the other station', { callsign });
  return (
    <button
      type="button"
      tabIndex={-1}
      data-worked={status ?? 'unknown'}
      className={`rounded px-0.5 font-semibold underline-offset-2 hover:bg-primary/10 ${style} ${confidenceOpacity(confidence)}`}
      title={hint ? `${title} · ${hint}` : title}
      onClick={() => {
        onCallsign(callsign);
        // Next step is in the log card (Enter = ESM); fall back to the buffer.
        if (!focusRttyCallsign()) focusRttyTxBuffer();
      }}
    >
      {callsign}
    </button>
  );
}

interface SegmentViewProps {
  segment: RttyTranscriptSegment;
  onCallsign?: (callsign: string) => void;
  onReport?: (report: string) => void;
  /** This station's call: shown, but not offered as the other station. */
  myCallsign?: string;
  /** The segment ends in a word still being received; it is not linked yet. */
  open?: boolean;
  /** Neighbouring TX/replay blocks already break the line: drop edge line breaks. */
  afterBlock?: boolean;
  beforeBlock?: boolean;
}

/** Removes leading/trailing line breaks next to block segments (no blank lines). */
function trimEdges(characters: RttyReceivedCharacter[], leading: boolean, trailing: boolean): RttyReceivedCharacter[] {
  let start = 0;
  let end = characters.length;
  if (leading) while (start < end && characters[start]!.ch === '\n') start += 1;
  if (trailing) while (end > start && characters[end - 1]!.ch === '\n') end -= 1;
  return start === 0 && end === characters.length ? characters : characters.slice(start, end);
}

/** One transcript segment; memoised because only the newest segment changes. */
const SegmentView = React.memo(function SegmentView({ segment, onCallsign, onReport, myCallsign, open, afterBlock, beforeBlock }: SegmentViewProps) {
  const { t } = useTranslation('radio');

  if (segment.kind === 'tx') {
    return (
      <span key={segment.id} className="block text-danger-500 dark:text-danger-400" data-rtty-segment="tx">
        {segment.text.replace(/^\n+|\n+$/g, '')}
      </span>
    );
  }
  const content = (
    <span data-rtty-segment={segment.kind === 'replay' ? undefined : 'rx'}>
      {groupReceivedWords(trimEdges(segment.characters, Boolean(afterBlock), Boolean(beforeBlock))).map((word, index, words) => {
        const partial = Boolean(open) && index === words.length - 1 && !word.whitespace;
        const kind = partial || isOwnCallsign(word.text, myCallsign) ? 'text' : classifyWord(word);
        const isCallsign = kind === 'callsign';
        const isReport = kind === 'report';
        const key = `${segment.id}-${index}`;
        if (isCallsign && onCallsign) {
          return (
            <React.Fragment key={key}>
              <CallsignButton callsign={word.text} confidence={word.confidence} onCallsign={onCallsign} />
              {word.whitespace}
            </React.Fragment>
          );
        }
        if (isReport && onReport) {
          return (
            <React.Fragment key={key}>
              <button
                type="button"
                tabIndex={-1}
                className={`rounded px-0.5 hover:bg-default-200 ${confidenceClass(word.confidence)}`}
                title={t('rtty.terminal.useReport', 'Use {{report}} as received report', { report: word.text })}
                onClick={() => {
                  onReport(word.text);
                  focusRttyTxBuffer();
                }}
              >
                {word.text}
              </button>
              {word.whitespace}
            </React.Fragment>
          );
        }
        return (
          <span key={key} className={confidenceClass(word.confidence)}>
            {word.text}
            {word.whitespace}
          </span>
        );
      })}
    </span>
  );
  if (segment.kind !== 'replay') return content;
  const last = segment.characters.at(-1)?.at ?? segment.replayFrom;
  return (
    <span
      className="my-1 block rounded-md border border-dashed border-primary/40 bg-primary/5 px-2 py-1"
      data-rtty-segment="replay"
    >
      <span className="mb-0.5 block font-sans text-[10px] font-medium text-primary">
        {t('rtty.terminal.replayLabel', 'Re-decoded with the new tuning (last {{seconds}} s)', {
          seconds: Math.max(1, Math.round((last - segment.replayFrom) / 1000)),
        })}
      </span>
      {content}
    </span>
  );
});

export const RttyTerminal: React.FC<RttyTerminalProps> = ({
  onCallsign,
  onReport,
  onOpenSettings,
  className,
}) => {
  const { t } = useTranslation('radio');
  const { decoderStatus, config } = useRtty();
  useWorkedCallsignContext('RTTY');
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const myCallsign = operators.find((operator) => operator.id === currentOperatorId)?.context?.myCall?.trim().toUpperCase() || undefined;
  const { transcript, clearTranscript } = useRttyTranscript();
  const canConfigure = useCan('update', 'RttyDecoderConfig');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setStickToBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= STICKY_BOTTOM_PX);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom) element.scrollTop = element.scrollHeight;
  }, [transcript, stickToBottom]);

  useEffect(() => { setStickToBottom(true); }, [transcript.sessionId]);

  const signal = decoderStatus?.signal ?? null;
  const state = decoderStatus?.state ?? 'disabled';
  const stateColor = state === 'listening'
    ? (signal?.locked ? 'success' : 'primary')
    : state === 'muted' ? 'warning' : state === 'error' || state === 'unavailable' ? 'danger' : 'default';
  const hasText = transcript.segments.length > 0;

  const signalSummary = useMemo(() => {
    if (!signal) return t('rtty.terminal.noSignal', 'No signal report');
    // Calibrated SNR in 3 kHz from the modem, plus how readable recent text was.
    const parts = [
      // -30 dB is the "not measured yet" floor.
      ...(signal.snrDb > -29.5 ? [`SNR ${signal.snrDb.toFixed(0)} dB`] : []),
      t('rtty.terminal.quality', 'Copy {{percent}}%', { percent: Math.round((signal.quality ?? 0) * 100) }),
    ];
    if (Math.abs(signal.frequencyOffsetHz) >= 0.5) {
      parts.push(`AFC ${signal.frequencyOffsetHz > 0 ? '+' : ''}${signal.frequencyOffsetHz.toFixed(0)} Hz`);
    }
    if (signal.reversed) parts.push(t('rtty.terminal.reversed', 'REV'));
    return parts.join(' · ');
  }, [signal, t]);

  const settingsHint = canConfigure
    ? t('rtty.settings.title', 'RTTY settings')
    : t('rtty.settings.permissionRequired', 'No permission to change RTTY settings');

  const profileSummary = config
    ? `${config.baud} Bd · ${config.shiftHz} Hz · ${config.sideband.toUpperCase()}`
    : '';

  return (
    <div className={`flex min-h-0 flex-col rounded-xl bg-content1/80 p-3 shadow-sm ring-1 ring-default-200/60 ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FontAwesomeIcon icon={faSatelliteDish} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-foreground">{t('rtty.terminal.title', 'RTTY Receive')}</span>
              <Chip size="sm" color={stateColor} variant="flat" className="h-5 text-[10px]">
                {signal?.locked && state === 'listening'
                  ? t('rtty.terminal.locked', 'Locked')
                  : t(`rtty.terminal.state.${state}`, state)}
              </Chip>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-default-500">
              {profileSummary && (onOpenSettings ? (
                <Tooltip content={settingsHint}>
                  {/* The modem parameters double as the way into the settings. */}
                  <button
                    type="button"
                    className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-default-100 px-2 font-medium text-default-700 transition-colors hover:bg-default-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-default-100"
                    disabled={!canConfigure}
                    onClick={onOpenSettings}
                    data-testid="rtty-profile-settings"
                  >
                    <FontAwesomeIcon icon={faGear} className="text-[10px] text-default-500" />
                    <span className="whitespace-nowrap">{profileSummary}</span>
                    <FontAwesomeIcon icon={faChevronDown} className="text-[8px] text-default-400" />
                  </button>
                </Tooltip>
              ) : (
                <span className="truncate">{profileSummary}</span>
              ))}
              <span className="truncate" data-testid="rtty-signal-summary">{signalSummary}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <RttyReceiveControls />
          {onOpenSettings && (
            <Tooltip content={settingsHint}>
              <span className="hidden sm:inline-flex">
                <Button
                  size="sm"
                  variant="flat"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  startContent={<FontAwesomeIcon icon={faGear} className="text-[10px]" />}
                  aria-label={t('rtty.settings.title', 'RTTY settings')}
                  isDisabled={!canConfigure}
                  onPress={onOpenSettings}
                >
                  {t('rtty.terminal.settings', 'Settings')}
                </Button>
              </span>
            </Tooltip>
          )}
          <Tooltip content={t('rtty.terminal.clearHint', 'Clear this screen (other operators keep their text)')}>
            <Button
              size="sm"
              variant="light"
              className="h-6 shrink-0 px-2 text-[11px]"
              startContent={<FontAwesomeIcon icon={faBroom} className="text-[10px]" />}
              onPress={() => { void clearTranscript(); }}
              isDisabled={!hasText}
            >
              {t('rtty.terminal.clear', 'Clear')}
            </Button>
          </Tooltip>
        </div>
      </div>

      <RttySignalBrowser myCallsign={myCallsign} onCallsign={onCallsign} />

      {decoderStatus?.error && (
        <Chip size="sm" variant="flat" color="danger" className="mt-3 max-w-full text-[11px]">
          <span className="truncate">{describeRttyError({ message: decoderStatus.error }, t)}</span>
        </Chip>
      )}

      <div className="relative mt-3 min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          spellCheck={false}
          role="log"
          aria-live="polite"
          aria-label={t('rtty.terminal.title', 'RTTY Receive')}
          className="h-full min-h-24 overflow-y-auto rounded-lg bg-content2 px-2.5 py-2 font-mono text-sm leading-6 whitespace-pre-wrap break-words"
        >
          {hasText
            ? transcript.segments.map((segment, index) => (
              <SegmentView
                key={segment.id}
                segment={segment}
                onCallsign={onCallsign}
                onReport={onReport}
                myCallsign={myCallsign}
                open={index === transcript.segments.length - 1}
                afterBlock={index > 0 && transcript.segments[index - 1]!.kind !== 'rx'}
                beforeBlock={index < transcript.segments.length - 1 && transcript.segments[index + 1]!.kind !== 'rx'}
              />
            ))
            : <span className="text-default-400">{t('rtty.terminal.empty', 'Listening for RTTY...')}</span>}
        </div>
        {!stickToBottom && hasText && (
          <Button
            isIconOnly
            size="sm"
            radius="full"
            variant="flat"
            className="absolute bottom-2 right-3 h-7 min-w-7 shadow"
            aria-label={t('rtty.terminal.latest', 'Jump to latest')}
            onPress={() => setStickToBottom(true)}
          >
            <FontAwesomeIcon icon={faAnglesDown} className="text-xs" />
          </Button>
        )}
      </div>
    </div>
  );
};
