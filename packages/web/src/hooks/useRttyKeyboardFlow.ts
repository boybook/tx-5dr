import { useCallback, useEffect, useRef } from 'react';
import { addToast } from '@heroui/toast';
import { useTranslation } from 'react-i18next';
import type { KeyboardMessageSlot } from '@tx5dr/contracts';
import { useRtty, useRttyTranscript, type RttyTranscriptSegment } from './useRtty';
import { rttyQsoDraftStore } from '../store/rttyQsoDraftStore';
import { lastCallsignIn } from '../components/rtty/rttyText';
import { focusRttyCallsign, logRttyQso, registerRttyEsmStep } from '../components/rtty/rttyQsoActions';
import { isMacOS } from '../utils/config';

/** Received segments searched (newest first) for a callsign to grab. */
const GRAB_SEGMENT_LOOKBACK = 4;

/**
 * The newest callsign in the received text that is not this station's own:
 * the last callsign of the most recent receive segment, falling back to
 * earlier segments when that one has none.
 */
export function latestReceivedCallsign(segments: RttyTranscriptSegment[], myCallsign?: string): string | null {
  let searched = 0;
  for (let index = segments.length - 1; index >= 0 && searched < GRAB_SEGMENT_LOOKBACK; index -= 1) {
    const segment = segments[index]!;
    if (segment.kind !== 'rx') continue;
    searched += 1;
    const callsign = lastCallsignIn(segment.characters.map((character) => character.ch).join(''), myCallsign);
    if (callsign) return callsign;
  }
  return null;
}

/** Finds a message slot by its label (case and spacing insensitive). */
export function findSlotByLabel(slots: KeyboardMessageSlot[], label: string): KeyboardMessageSlot | null {
  const wanted = label.replace(/\s+/g, ' ').trim().toUpperCase();
  return slots.find((slot) => slot.text.trim() && slot.label.replace(/\s+/g, ' ').trim().toUpperCase() === wanted) ?? null;
}

/** True for the "log QSO" chord: Ctrl+Enter, or Cmd+Enter on macOS. */
export function isLogChord(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

/** True for the "grab callsign" chord: Alt+G (Option+G). Uses the key code: Option changes `key` on macOS. */
export function isGrabChord(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return event.code === 'KeyG' && event.altKey && !event.ctrlKey && !event.metaKey;
}

/** True for the "return to receive after the buffer" chord: Alt+R (Option+R). */
export function isFinishChord(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return event.code === 'KeyR' && event.altKey && !event.ctrlKey && !event.metaKey;
}

/** Platform labels for the shortcut hints. */
export function rttyShortcutLabels(): { log: string; grab: string; finish: string } {
  return isMacOS()
    ? { log: '⌘↵', grab: '⌥G', finish: '⌥R' }
    : { log: 'Ctrl+Enter', grab: 'Alt+G', finish: 'Alt+R' };
}

/** A sent macro, as observed from the transmit status (any client). */
interface SentMacro {
  label: string;
  at: number;
}

/**
 * ESM decisions from what was actually sent, including F-keys and clicks:
 * running = our latest CQ is newer than our latest CALL; the exchange is sent
 * when EXCH or R EXCH went out after the callsign was entered.
 */
export function esmPlan(sent: SentMacro[], callsignSince: number): { running: boolean; exchangeSent: boolean } {
  const latest = (labels: string[]) => sent.reduce((at, item) => (labels.includes(item.label) ? Math.max(at, item.at) : at), -Infinity);
  const cqAt = latest(['CQ']);
  const callAt = latest(['CALL']);
  return {
    running: cqAt > callAt,
    exchangeSent: latest(['EXCH', 'R EXCH']) >= callsignSince,
  };
}

const normaliseLabel = (label: string) => label.replace(/\s+/g, ' ').trim().toUpperCase();
/** Sent macros remembered for ESM. */
const SENT_HISTORY_LIMIT = 32;

export interface UseRttyKeyboardFlowOptions {
  /** Shortcuts are active only while true (RTTY mode with an operator callsign). */
  enabled: boolean;
  myCallsign: string;
  /** Visible macro slots; ESM uses the ones labelled EXCH, R EXCH and TU. */
  slots: KeyboardMessageSlot[];
  /** Sends a slot; returns false when it was not sent (missing placeholder...). */
  play(slot: KeyboardMessageSlot): boolean;
}


/**
 * Contest keyboard flow for RTTY:
 * - Alt+G grabs the newest received callsign into the QSO draft;
 * - Ctrl/Cmd+Enter logs the QSO from the RTTY log card;
 * - Enter in the log card's callsign field (ESM): the first press sends the
 *   exchange (EXCH after our CQ, R EXCH when we answered someone), the second
 *   sends TU and logs (after R EXCH, which already says TU, it only logs).
 */
export function useRttyKeyboardFlow({ enabled, myCallsign, slots, play }: UseRttyKeyboardFlowOptions): void {
  const { t } = useTranslation('radio');
  const { transcript } = useRttyTranscript();
  const { txStatus, finish } = useRtty();
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  // Macros sent by any means (F-keys, clicks, ESM, loop), in order.
  const sentRef = useRef<SentMacro[]>([]);
  const recordSent = useCallback((label: string) => {
    sentRef.current = [...sentRef.current, { label: normaliseLabel(label), at: Date.now() }].slice(-SENT_HISTORY_LIMIT);
  }, []);
  // sessionKey changes for every new transmission and every chained macro;
  // it is recorded once the slots (labels) are known.
  const sessionKey = `${txStatus?.sessionId ?? ''}|${txStatus?.messageId ?? ''}`;
  const recordedKeyRef = useRef('');
  const messageId = txStatus?.messageId ?? null;
  useEffect(() => {
    if (!messageId || recordedKeyRef.current === sessionKey) return;
    const slot = slots.find((item) => item.id === messageId);
    if (!slot) return;
    recordedKeyRef.current = sessionKey;
    recordSent(slot.label);
  }, [messageId, recordSent, sessionKey, slots]);
  // When the current his-callsign was entered (ESM restarts for a new QSO).
  const callsignSinceRef = useRef(0);

  const grabCallsign = useCallback(() => {
    const callsign = latestReceivedCallsign(transcriptRef.current.segments, myCallsign);
    if (!callsign) {
      addToast({ title: t('rtty.flow.noCallsign', 'No callsign in the received text'), color: 'warning', timeout: 2500 });
      return;
    }
    rttyQsoDraftStore.setHisCallsign(callsign);
    // Contest flow continues in the callsign field (Enter = next ESM step).
    focusRttyCallsign();
  }, [myCallsign, t]);

  const logQso = useCallback(async () => {
    const logged = await logRttyQso();
    if (!logged && !rttyQsoDraftStore.getSnapshot().hisCallsign) {
      addToast({ title: t('rtty.flow.nothingToLog', 'Enter a callsign before logging'), color: 'warning', timeout: 2500 });
    }
  }, [t]);

  const esmStep = useCallback(() => {
    const callsign = rttyQsoDraftStore.getSnapshot().hisCallsign;
    if (!callsign) return;
    const state = esmPlan(sentRef.current, callsignSinceRef.current);
    if (!state.exchangeSent) {
      const label = state.running ? 'EXCH' : 'R EXCH';
      const slot = findSlotByLabel(slots, label);
      if (!slot) {
        addToast({ title: t('rtty.flow.missingSlot', 'No macro labelled {{label}}', { label }), color: 'warning', timeout: 3000 });
        return;
      }
      // Counted at once; the transmit status confirms it shortly after.
      if (play(slot)) recordSent(slot.label);
      return;
    }
    if (state.running) {
      const tu = findSlotByLabel(slots, 'TU');
      if (tu && !play(tu)) return;
      if (tu) recordSent(tu.label);
    }
    void logQso();
  }, [logQso, play, recordSent, slots, t]);

  useEffect(() => (enabled ? registerRttyEsmStep(esmStep) : undefined), [enabled, esmStep]);

  // A new QSO (cleared or different callsign) starts the ESM sequence again.
  const { hisCallsign } = rttyQsoDraftStore.useDraft();
  useEffect(() => { callsignSinceRef.current = Date.now(); }, [hisCallsign]);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      // Shortcuts never act from inside a dialog (e.g. RTTY settings).
      if ((event.target as Element | null)?.closest?.('[role="dialog"]')) return;
      if (isFinishChord(event)) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      } else if (isLogChord(event)) {
        event.preventDefault();
        event.stopPropagation();
        void logQso();
      } else if (isGrabChord(event)) {
        event.preventDefault();
        event.stopPropagation();
        grabCallsign();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [enabled, finish, grabCallsign, logQso]);
}
