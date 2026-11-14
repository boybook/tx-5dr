import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBroom, faUserTag } from '@fortawesome/free-solid-svg-icons';
import { extractCallsign } from '../../utils/extractCallsign';

const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 8;

export interface DecoderTranscriptLabels {
  /** Section heading, e.g. "Transcript". */
  title: string;
  /** Shown while there is no text. */
  empty: string;
  /** Button label/tooltip when a callsign was found. */
  useCallsign(callsign: string): string;
  /** Button label/tooltip when none was found. */
  noCallsign: string;
  clear: string;
}

export interface DecoderTranscriptViewProps {
  /**
   * Render the transcript. While false the view renders nothing but keeps its
   * "follow the bottom" scroll state, so keep it mounted while hidden.
   */
  visible: boolean;
  /** Final text; the callsign button looks only here. */
  confirmedText: string;
  /** Provisional text rendered dimmed after the confirmed text. */
  pendingText: string;
  labels: DecoderTranscriptLabels;
  /** Called with the first callsign of `confirmedText`. */
  onUseCallsign(callsign: string): void;
  onClear(): void;
  clearDisabled: boolean;
}

function isNearScrollBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
}

/**
 * Decoder transcript box with a "use callsign" and a clear button. It follows
 * new text while scrolled to the bottom and stops following when the user
 * scrolls up.
 */
export function DecoderTranscriptView({
  visible,
  confirmedText,
  pendingText,
  labels,
  onUseCallsign,
  onClear,
  clearDisabled,
}: DecoderTranscriptViewProps) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollTranscriptRef = useRef(true);
  const callsign = useMemo(() => extractCallsign(confirmedText), [confirmedText]);
  const hasTranscript = Boolean(confirmedText || pendingText);
  const renderedPendingText = pendingText && confirmedText ? ` ${pendingText}` : pendingText;

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (!shouldAutoScrollTranscriptRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [confirmedText, pendingText, visible]);

  const handleTranscriptScroll = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    shouldAutoScrollTranscriptRef.current = isNearScrollBottom(transcript);
  }, []);

  if (!visible) return null;

  const callsignLabel = callsign ? labels.useCallsign(callsign) : labels.noCallsign;

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-default-500">
          {labels.title}
        </span>
        <div className="flex items-center gap-1">
          <Tooltip content={callsignLabel}>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              color={callsign ? 'primary' : 'default'}
              className="h-6 min-w-6 text-[11px]"
              isDisabled={!callsign}
              aria-label={callsignLabel}
              onPress={() => callsign && onUseCallsign(callsign)}
            >
              <FontAwesomeIcon icon={faUserTag} className="text-[10px]" />
            </Button>
          </Tooltip>
          <Button
            size="sm"
            variant="light"
            className="h-6 px-2 text-[11px]"
            startContent={<FontAwesomeIcon icon={faBroom} className="text-[10px]" />}
            onPress={onClear}
            isDisabled={clearDisabled}
          >
            {labels.clear}
          </Button>
        </div>
      </div>
      <div
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-readonly="true"
        className="h-16 overflow-y-auto rounded-lg bg-content2 px-2.5 py-2 font-mono text-sm leading-6 text-foreground whitespace-pre-wrap break-words outline-none"
      >
        {hasTranscript ? (
          <>
            {confirmedText && <span>{confirmedText}</span>}
            {renderedPendingText && <span className="text-default-400 opacity-80">{renderedPendingText}</span>}
          </>
        ) : (
          <span className="text-default-400">{labels.empty}</span>
        )}
      </div>
    </div>
  );
}
