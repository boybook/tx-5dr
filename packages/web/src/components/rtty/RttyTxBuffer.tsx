import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Switch, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPaperPlane, faStop, faTowerBroadcast, faHeadphones, faRepeat } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { KeyboardPlaceholderValues } from '@tx5dr/contracts';
import { useRtty } from '../../hooks/useRtty';
import { useAuth } from '../../store/authStore';
import { describeRttyError } from './rttyErrors';
import { registerRttyTxBufferFocus } from './rttyFocus';

export type RttyTextInputMode = 'realtime' | 'line';

const INPUT_MODE_STORAGE_KEY = 'tx5dr_rtty_text_input_mode';

/** Max characters sent in one line or paste (the server schema accepts 500). */
const MAX_CHUNK = 480;

/** Touch devices default to line mode: soft keyboards report unreliable keydown events. */
function prefersLineMode(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function readInputMode(): RttyTextInputMode {
  try {
    const saved = localStorage.getItem(INPUT_MODE_STORAGE_KEY);
    if (saved === 'line' || saved === 'realtime') return saved;
  } catch {
    // Fall through to the device default.
  }
  return prefersLineMode() ? 'line' : 'realtime';
}

function writeInputMode(mode: RttyTextInputMode): void {
  try {
    localStorage.setItem(INPUT_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable (private mode); the choice is then per session.
  }
}

/** Keys that produce a transmittable character in realtime mode. */
function printableKey(event: React.KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return null;
  if (event.key === 'Enter') return '\n';
  return event.key.length === 1 ? event.key.toUpperCase() : null;
}

/**
 * True when a key event belongs to a control that takes typing or arrow/letter
 * navigation of its own (text fields, selects, menus, sliders), or to a dialog.
 * Such keys are never redirected to the transmit buffer.
 */
export function ownsTyping(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return Boolean(el.closest('[role="dialog"],[role="menu"],[role="listbox"],[role="combobox"],[role="slider"],[role="textbox"],[contenteditable="true"]'));
}

/** A printable character typed without modifiers (a global keydown), or null. */
export function strayPrintableKey(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  return event.key.length === 1 ? event.key : null;
}

/** Translates a server `RTTY_*` code, falling back to the raw text. */
function useRttyMessage() {
  const { t } = useTranslation('radio');
  return useCallback((code: string) => describeRttyError({ message: code }, t), [t]);
}

export interface RttyTxBufferProps {
  placeholderValues?: KeyboardPlaceholderValues;
  /** Label of the message slot the automatic repeat sends (e.g. `CQ`). */
  repeatLabel?: string | null;
  /** Stop action for Esc and the Stop button; defaults to aborting the transmission. */
  onStop?: () => void;
  /** Shows a short "stopped" state after the operator stopped the transmission. */
  stopped?: boolean;
}

function useCountdown(until: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : null;
}

/**
 * Type-ahead transmit buffer.
 *
 * Realtime mode sends every keystroke to the server buffer and keys up on the
 * first one; Backspace retracts characters that have not been committed to
 * audio yet. Line mode composes a line locally and sends it on Enter, ending
 * the transmission afterwards. Sent, committed and pending text are shown in
 * distinct styles from the server's status.
 */
export const RttyTxBuffer: React.FC<RttyTxBufferProps> = ({ placeholderValues, repeatLabel, onStop, stopped = false }) => {
  const { t } = useTranslation('radio');
  const translateCode = useRttyMessage();
  const { txStatus, canTransmit, isRttyMode, append, retract, finish, abort: abortTx } = useRtty();
  const { state: authState } = useAuth();
  const abort = onStop ?? abortTx;
  const [inputMode, setInputMode] = useState<RttyTextInputMode>(readInputMode);
  const [line, setLine] = useState('');
  const captureRef = useRef<HTMLTextAreaElement | null>(null);
  const lineRef = useRef<HTMLInputElement | null>(null);

  const active = txStatus?.active ?? false;
  const onAir = txStatus?.phase === 'on_air' || txStatus?.phase === 'draining';
  const typeAhead = txStatus?.typeAheadSupported ?? true;
  const pendingText = txStatus?.pendingText ?? '';
  const finishing = active && (txStatus?.finishing ?? false);
  const repeat = txStatus?.repeat ?? null;
  const repeatCountdown = useCountdown(repeat?.nextRunAt ?? null);

  useEffect(() => { writeInputMode(inputMode); }, [inputMode]);

  // Shown after a stray key moved focus here without transmitting.
  const [focusHint, setFocusHint] = useState(false);
  const focusHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFocusHint = useCallback(() => {
    setFocusHint(true);
    if (focusHintTimer.current) clearTimeout(focusHintTimer.current);
    focusHintTimer.current = setTimeout(() => setFocusHint(false), 3_000);
  }, []);
  useEffect(() => () => { if (focusHintTimer.current) clearTimeout(focusHintTimer.current); }, []);
  useEffect(() => { if (active) setFocusHint(false); }, [active]);

  // Other panels (terminal clicks, stray typing) hand keyboard focus back here.
  const focusBuffer = useCallback(() => {
    const target = inputMode === 'realtime' ? captureRef.current : lineRef.current;
    target?.focus({ preventScroll: true });
  }, [inputMode]);
  useEffect(() => registerRttyTxBufferFocus(focusBuffer), [focusBuffer]);

  // A printable key typed while nothing that takes text has focus (body, a
  // macro button...) would otherwise be lost: focus the buffer and deliver it.
  // Runs after the capture-phase F-key/Escape handler, in the bubble phase.
  const strayKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  strayKeyRef.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isRttyMode || !canTransmit || ownsTyping(event.target)) return;
    const ch = strayPrintableKey(event);
    if (ch === null) return;
    event.preventDefault();
    focusBuffer();
    if (inputMode === 'realtime') {
      // A stray key must never key up the transmitter: while receiving it only
      // moves focus here (typing in the buffer then transmits). During a
      // transmission it is appended like any typed character.
      // start: false — if the transmission ended a moment ago the server refuses
      // instead of keying up a new one (fail closed).
      // While finishing (or on a whole-message path) the server would only
      // queue it for another transmission, so only move focus then too.
      if (active && !finishing && typeAhead) append(ch.toUpperCase(), { start: false, placeholderValues });
      else showFocusHint();
    } else {
      setLine((current) => `${current}${ch}`.toUpperCase().slice(0, MAX_CHUNK));
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => strayKeyRef.current(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Keys are consumed here and never reach the textarea value. Escape may
  // already have been handled (and prevented) by the macro panel's global
  // hotkey listener, which then owns the abort.
  const handleRealtimeKey = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (active || repeat) abort();
      return;
    }
    if (!canTransmit) return;
    if (event.key === 'Backspace') {
      event.preventDefault();
      // The server owns the buffer and ignores a retract with nothing unsent,
      // so do not gate on the (possibly stale) pending text here.
      retract(1);
      return;
    }
    const ch = printableKey(event);
    if (ch === null) return;
    event.preventDefault();
    // A lone Enter while receiving (e.g. meant for the log card) must not key
    // up: only a typed character starts a transmission; TX/the buttons do too.
    if (ch === '\n' && !active) {
      showFocusHint();
      return;
    }
    append(ch, { placeholderValues });
  }, [abort, active, append, canTransmit, placeholderValues, repeat, retract, showFocusHint]);

  // Soft keyboards often send keydown without a usable key; their text arrives
  // as input instead. Forward it and keep the textarea empty.
  const handleRealtimeInput = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    event.target.value = '';
    if (!text || !canTransmit) return;
    append(text.toUpperCase().slice(0, MAX_CHUNK), { placeholderValues });
  }, [append, canTransmit, placeholderValues]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    if (!canTransmit) return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    append(text.toUpperCase().slice(0, MAX_CHUNK), { placeholderValues });
  }, [append, canTransmit, placeholderValues]);

  const sendLine = useCallback(() => {
    const text = line.trim();
    if (!text || !canTransmit) return;
    append(`${active ? ' ' : '\n'}${text}\n`, { finishAfter: true, placeholderValues });
    setLine('');
  }, [active, append, canTransmit, line, placeholderValues]);

  const statusText = !isRttyMode
    ? ''
    : txStatus?.error
      ? translateCode(txStatus.error)
      : !txStatus?.available
        ? (txStatus?.unavailableReason ? translateCode(txStatus.unavailableReason) : t('rtty.tx.unavailable', 'Transmit unavailable'))
        : stopped && !active
          ? t('rtty.tx.stopped', 'Stopped')
          : t(`rtty.tx.phase.${txStatus.phase}`, txStatus.phase);
  // Only worth showing when another client keyed up.
  const owner = active && authState.authEnabled && txStatus?.startedByLabel && txStatus.startedByLabel !== authState.label
    ? txStatus.startedByLabel
    : null;
  const repeatText = repeat
    ? (repeat.nextRunAt
      ? t('rtty.tx.repeatWaiting', 'Repeating {{label}}: next in {{seconds}} s', { label: repeatLabel || 'CQ', seconds: repeatCountdown ?? repeat.intervalSec })
      : t('rtty.tx.repeatSending', 'Repeating {{label}} every {{seconds}} s', { label: repeatLabel || 'CQ', seconds: repeat.intervalSec }))
    : null;

  return (
    <div className="flex flex-col gap-2" data-testid="rtty-tx-buffer">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <div className="flex min-w-[6rem] flex-1 items-center gap-2 text-[11px] text-default-500" data-testid="rtty-tx-status">
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${onAir ? 'animate-pulse bg-danger' : active ? 'bg-warning' : stopped ? 'bg-danger-300' : 'bg-default-300'}`} />
          <span
            className={`${repeatText || finishing ? 'shrink-0' : 'truncate'} ${stopped && !active ? 'font-semibold text-danger' : ''}`}
            title={owner ? t('rtty.tx.startedBy', 'by {{label}}', { label: owner }) : undefined}
          >
            {statusText}
          </span>
          {/* A repeat always returns to receive after each message: its chip says enough. */}
          {finishing && !repeatText && (
            <span className="min-w-0 truncate rounded bg-default-100 px-1.5 py-px text-default-600" data-testid="rtty-finishing">
              {t('rtty.tx.finishing', 'Returns to receive after this')}
            </span>
          )}
          {repeatText && (
            <span className="flex min-w-0 shrink items-center gap-1 truncate rounded bg-warning-100 px-1.5 py-px text-warning-700 dark:bg-warning-500/20 dark:text-warning-400" data-testid="rtty-repeat">
              <FontAwesomeIcon icon={faRepeat} className="text-[9px]" />
              <span className="truncate">{repeatText}</span>
            </span>
          )}
          {owner && !finishing && !repeatText && (
            <span className="truncate">{t('rtty.tx.startedBy', 'by {{label}}', { label: owner })}</span>
          )}
          {active && !typeAhead && (
            <span className="truncate text-warning">{t('rtty.tx.preparedOnly', 'Whole messages only on this audio path')}</span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Tooltip content={t('rtty.tx.keyUpHint', 'Key up and send idle diddles')}>
            <Button
              size="sm"
              variant="flat"
              color="danger"
              className="h-7 min-w-0 px-2.5"
              startContent={<FontAwesomeIcon icon={faTowerBroadcast} className="text-[10px]" />}
              isDisabled={!canTransmit || active}
              onPress={() => append('\n', { placeholderValues })}
            >
              {t('rtty.tx.keyUp', 'TX')}
            </Button>
          </Tooltip>
          <Tooltip content={t('rtty.tx.receiveHint', 'Return to receive after the buffer is sent')}>
            <Button
              size="sm"
              variant="flat"
              className="h-7 min-w-0 px-2.5"
              startContent={<FontAwesomeIcon icon={faHeadphones} className="text-[10px]" />}
              isDisabled={!active || (txStatus?.finishing ?? false)}
              onPress={finish}
            >
              {t('rtty.tx.receive', 'RX')}
            </Button>
          </Tooltip>
          <Tooltip content={t('rtty.tx.abortHint', 'Stop now and discard unsent text (Esc)')}>
            <Button
              size="sm"
              variant="solid"
              color="danger"
              className="h-7 min-w-0 px-2.5"
              startContent={<FontAwesomeIcon icon={faStop} className="text-[10px]" />}
              isDisabled={!active && !repeat}
              onPress={abort}
            >
              {t('rtty.tx.abort', 'Stop')}
            </Button>
          </Tooltip>
          <Switch
            size="sm"
            isSelected={inputMode === 'realtime'}
            onValueChange={(realtime) => setInputMode(realtime ? 'realtime' : 'line')}
            classNames={{ base: 'ml-1', label: 'text-[11px] text-default-500 whitespace-nowrap' }}
          >
            {t('rtty.tx.realtime', 'Type ahead')}
          </Switch>
        </div>
      </div>

      {inputMode === 'realtime' ? (
        <div
          className={`relative min-h-14 [@media(max-height:820px)]:min-h-10 cursor-text rounded-lg bg-content2 px-2.5 py-2 font-mono text-sm leading-6 whitespace-pre-wrap break-words ring-offset-1 focus-within:ring-2 ${onAir ? 'focus-within:ring-danger' : 'focus-within:ring-primary'} ${canTransmit ? '' : 'opacity-60'}`}
          onClick={() => captureRef.current?.focus()}
        >
          {/* A real (transparent) textarea receives the keys so soft keyboards
              open and global shortcuts treat it as a text field. */}
          <textarea
            ref={captureRef}
            aria-label={t('rtty.tx.bufferLabel', 'Transmit buffer: type to send')}
            data-testid="rtty-capture"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={handleRealtimeKey}
            onChange={handleRealtimeInput}
            onPaste={handlePaste}
            className="absolute inset-0 h-full w-full resize-none bg-transparent text-transparent caret-transparent opacity-0 outline-none"
          />
          {txStatus && (txStatus.sentText || txStatus.committedText || pendingText) ? (
            <>
              <span className="text-default-400" data-testid="rtty-sent">{txStatus.sentText}</span>
              <span className="text-danger-500 dark:text-danger-400" data-testid="rtty-committed">{txStatus.committedText}</span>
              <span className="rounded-sm bg-primary/10 text-primary" data-testid="rtty-pending">{pendingText}</span>
              {finishing && (
                <span
                  className="mx-0.5 inline-flex h-5 items-center rounded border border-default-300 bg-default-200 px-1 align-middle font-mono text-[10px] font-bold leading-none text-default-700"
                  title={t('rtty.tx.finishing', 'Returns to receive after this')}
                  data-testid="rtty-rx-marker"
                >
                  RX
                </span>
              )}
              <span className="ml-px inline-block h-4 w-px animate-pulse bg-foreground align-middle" />
            </>
          ) : (
            <span className={focusHint ? 'text-warning-600 dark:text-warning-400' : 'text-default-400'} data-testid={focusHint ? 'rtty-focus-hint' : undefined}>
              {!canTransmit
                ? t('rtty.tx.placeholderDisabled', 'Transmit is not available')
                : focusHint
                  ? t('rtty.tx.focusHint', 'Typing goes here now. Type again to transmit.')
                  : t('rtty.tx.placeholder', 'Click here and type: each key is transmitted. Backspace removes unsent text, Esc stops.')}
            </span>
          )}
        </div>
      ) : (
        <Input
          ref={lineRef}
          size="sm"
          value={line}
          onValueChange={(value) => setLine(value.toUpperCase().slice(0, MAX_CHUNK))}
          maxLength={MAX_CHUNK}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); sendLine(); }
            if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); if (active || repeat) abort(); }
          }}
          placeholder={t('rtty.tx.linePlaceholder', 'Type a line and press Enter to send')}
          isDisabled={!canTransmit}
          classNames={{ input: 'font-mono uppercase' }}
          endContent={(
            <Button isIconOnly size="sm" variant="light" aria-label={t('rtty.tx.send', 'Send')} onPress={sendLine} isDisabled={!line.trim() || !canTransmit}>
              <FontAwesomeIcon icon={faPaperPlane} className="text-xs" />
            </Button>
          )}
        />
      )}

    </div>
  );
};
