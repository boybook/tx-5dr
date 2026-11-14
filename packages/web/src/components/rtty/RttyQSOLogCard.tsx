import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleCheck, faCircleInfo, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { rttyMarkRfFrequency, type QSORecord } from '@tx5dr/contracts';
import { useRtty } from '../../hooks/useRtty';
import { rttyShortcutLabels } from '../../hooks/useRttyKeyboardFlow';
import { rttyQsoDraftStore, useRttyQSODraft } from '../../store/rttyQsoDraftStore';
import { noteLocallyLoggedQso } from '../../utils/localQsoLog';
import { ModeQSOLogCard } from '../keyboard-mode/ModeQSOLogCard';
import { useWorkedCallsignContext, useWorkedStatus } from './useWorkedCallsigns';
import { registerRttyCallsignFocus, registerRttyQsoLogger, runRttyEsmStep } from './rttyQsoActions';
import { hasFinePointer } from './rttyFocus';
import { isRttyCallsign } from './rttyText';

/** False when the element or a clipping ancestor (collapsed card) has no visible box. */
function isShown(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const rect = node.getBoundingClientRect();
    if (rect.height < 1 || rect.width < 1) return false;
    if (node === document.body) break;
  }
  return true;
}

interface RttyQSOLogCardProps {
  editingQSO?: QSORecord | null;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onEditComplete?: (updated: QSORecord) => void;
  onDeleteComplete?: (deletedId: string) => void;
  onCancelEdit?: () => void;
}

/** Waits until typing pauses before looking a callsign up in the log. */
const WORKED_LOOKUP_DELAY_MS = 300;

function useSettledValue(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return settled;
}

/** Worked-before status of a complete callsign; dupes are warned but may still be logged. */
function WorkedHint({ callsign }: { callsign: string }) {
  const { t } = useTranslation('radio');
  const status = useWorkedStatus(callsign);
  if (!status) return null;
  const style = status === 'dupe'
    ? { icon: faTriangleExclamation, className: 'bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-warning-400' }
    : status === 'worked'
      ? { icon: faCircleInfo, className: 'bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300' }
      : { icon: faCircleCheck, className: 'bg-success-50 text-success-700 dark:bg-success-500/15 dark:text-success-400' };
  const text = status === 'dupe'
    ? t('rtty.qso.workedDupe', '{{callsign}}: dupe, already worked on this band in RTTY', { callsign })
    : status === 'worked'
      ? t('rtty.qso.workedBefore', '{{callsign}}: worked before on another band or mode', { callsign })
      : t('rtty.qso.workedNew', '{{callsign}}: new station', { callsign });
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${style.className}`}
      data-testid="rtty-worked-hint"
      data-worked={status}
      role={status === 'dupe' ? 'alert' : undefined}
    >
      <FontAwesomeIcon icon={style.icon} className="text-[11px]" />
      <span className="truncate">{text}</span>
    </div>
  );
}

function CallsignStatus({ hidden }: { hidden: boolean }) {
  const { hisCallsign } = useRttyQSODraft();
  const settled = useSettledValue(hisCallsign, WORKED_LOOKUP_DELAY_MS);
  if (hidden || !settled || settled !== hisCallsign || !isRttyCallsign(settled)) return null;
  return <WorkedHint callsign={settled} />;
}

function ShortcutHints() {
  const { t } = useTranslation('radio');
  const keys = rttyShortcutLabels();
  const kbd = 'rounded border border-default-300 bg-default-100 px-1 font-mono text-[10px] text-default-600';
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-default-400 [@media(pointer:coarse)]:hidden" data-testid="rtty-shortcut-hints">
      <span><kbd className={kbd}>{keys.grab}</kbd> {t('rtty.flow.grabHint', 'grab the latest received callsign')}</span>
      <span><kbd className={kbd}>↵</kbd> {t('rtty.flow.esmHint', 'in Callsign: send exchange, then TU and log')}</span>
      <span><kbd className={kbd}>{keys.log}</kbd> {t('rtty.flow.logHint', 'log QSO')}</span>
      <span><kbd className={kbd}>{keys.finish}</kbd> {t('rtty.flow.finishHint', 'send the buffer, then receive')}</span>
    </div>
  );
}

/**
 * RTTY QSO log card: mode RTTY, 599 reports, start time from the first
 * callsign entered, frequency logged as the mark RF frequency, a dupe check
 * and the contest keyboard flow (Enter-sends-message in the callsign field,
 * Ctrl/Cmd+Enter to log from anywhere).
 */
export const RttyQSOLogCard: React.FC<RttyQSOLogCardProps> = (props) => {
  const { txStatus, config } = useRtty();
  const { t } = useTranslation('radio');
  useWorkedCallsignContext('RTTY');
  const toMarkFrequency = useCallback(
    (dialFrequencyHz: number) => (config ? rttyMarkRfFrequency(dialFrequencyHz, config) : dialFrequencyHz),
    [config],
  );
  const logActionRef = useRef<(() => Promise<boolean>) | null>(null);
  useEffect(() => registerRttyQsoLogger(() => logActionRef.current?.() ?? Promise.resolve(false)), []);

  const isEditing = Boolean(props.editingQSO);
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  useEffect(() => registerRttyCallsignFocus(() => {
    if (isEditingRef.current || !hasFinePointer()) return false;
    const input = document.querySelector<HTMLInputElement>('input[data-qso-callsign-input]');
    if (!input || !isShown(input)) return false;
    input.focus();
    return true;
  }), []);
  const handleCallsignKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement> & { continuePropagation?: () => void }) => {
    const plainEnter = event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    // ESM only with a physical keyboard and visible hints: on touch screens a
    // soft keyboard's Enter/Go must not key up the transmitter.
    if (!plainEnter || event.repeat || isEditing || event.nativeEvent.isComposing || !hasFinePointer()) {
      // HeroUI (react-aria) stops key propagation once a handler is set; keep other keys flowing.
      event.continuePropagation?.();
      return;
    }
    event.preventDefault();
    runRttyEsmStep();
  }, [isEditing]);

  return (
    <ModeQSOLogCard
      {...props}
      mode="RTTY"
      defaultReport="599"
      rstMaxLength={3}
      txActive={txStatus?.active ?? false}
      draftStore={rttyQsoDraftStore}
      i18nPrefix="radio:rtty.qso"
      qsoFrequencyFromDial={toMarkFrequency}
      syncReportsFromDraft
      startTimeFromCallsign
      callsignAdornment={<CallsignStatus hidden={isEditing} />}
      onCallsignKeyDown={handleCallsignKeyDown}
      logActionRef={logActionRef}
      onBeforeLog={noteLocallyLoggedQso}
      logButtonTitle={t('rtty.flow.logTitle', 'Log QSO ({{keys}})', { keys: rttyShortcutLabels().log })}
      footer={isEditing ? undefined : <ShortcutHints />}
    />
  );
};
