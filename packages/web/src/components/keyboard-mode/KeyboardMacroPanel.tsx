import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Input,
  Select,
  SelectItem,
  Tabs,
  Tab,
  Chip,
  Tooltip,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faStop,
  faPen,
  faEraser,
  faRepeat,
  faClock,
  faTowerBroadcast,
  faGear,
  faPlus,
  faMinus,
  faGripVertical,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { KeyboardMessageSlot } from '@tx5dr/contracts';
import type { MessageSegment } from '../../utils/messagePlaceholders';
import { useOperators, useCurrentOperatorId } from '../../store/radioStore';
import type { KeyerShortcutPreset } from '../../utils/keyerShortcutPreferences';
import { clampRepeatIntervalSec, type MacroPanelMode, type UseMacroPanelResult } from '../../hooks/useMacroPanel';
import type { UseSlotShortcutsResult } from '../../hooks/useSlotShortcuts';
import type { UseMessagePlaceholdersResult } from './useMessagePlaceholders';
import { useModeText, type KeyboardModeI18n } from './modeText';

const TX_PROGRESS_OVERHEAD_MS = 650;

/** Built-in English fallbacks for the panel texts (`${prefix}.<key>`). */
export const KEYBOARD_MACRO_PANEL_TEXT_DEFAULTS: Partial<Record<string, string>> = {
  keyerTitle: 'Keyer',
  settings: 'Settings',
  modeTabs: 'Keyer mode',
  operateMode: 'Transmit',
  editMode: 'Edit',
  operator: 'Operator',
  presetMessages: 'Presets',
  decreaseSlots: 'Remove slot',
  increaseSlots: 'Add slot',
  noMessages: 'No messages configured',
  emptySlotHint: 'Edit this slot first',
  repeatToggle: 'Repeat toggle',
  repeatInterval: 'Interval (s)',
  messageText: 'Text',
  messageTextPlaceholder: 'CQ CQ CQ DE {{callsign}}',
  messageLabel: 'Label',
  clearSlot: 'Clear',
};

export type MacroSlotPhase = 'transmitting' | 'waiting';

export interface KeyboardMacroPanelRepeatOptions {
  /** Toggle the slot's repeat flag (the consumer persists and starts/stops playback). */
  onToggle(slot: KeyboardMessageSlot): void;
  /** Repeat interval input changed (raw input value). Usually `macro.setRepeatIntervalSec`. */
  onIntervalChange(slot: KeyboardMessageSlot, value: string): void;
  /** When the waiting slot runs next (ms epoch), for the countdown and progress. */
  nextRunAt?: number | null;
}

export interface KeyboardMacroPanelProps {
  /** Rendered inside the left layout pane instead of a Card. */
  embedded?: boolean;
  /** i18n scope, e.g. `{ prefix: 'radio:cw', defaults: { keyerTitle: 'CW Keyer' } }`. Keep stable. */
  i18n: KeyboardModeI18n;
  /** Header icon. */
  icon: IconDefinition;
  /** Header status chip (rendered after the title). */
  statusChip?: React.ReactNode;
  /** Settings popover body; the gear button is hidden when omitted. */
  settingsContent?: React.ReactNode;
  /** Rendered first in the body (e.g. warning alerts). */
  alerts?: React.ReactNode;
  /** Rendered between the alerts and the presets (text input / TX buffer). */
  inputArea?: React.ReactNode;
  /** State and actions from `useMacroPanel`. */
  macro: UseMacroPanelResult;
  /** State and actions from `useSlotShortcuts`. */
  shortcuts: UseSlotShortcutsResult;
  /** From `useMessagePlaceholders`; renders slot text and the edit hint. */
  placeholders: UseMessagePlaceholdersResult;
  /** True while this mode transmits: other slots and edits are disabled. */
  isBusy: boolean;
  /** Slot currently transmitting or waiting to repeat. */
  activeSlotId: string | null;
  activeSlotPhase: MacroSlotPhase | null;
  /** Slot button pressed in operate view (also for the active slot: stop it). */
  onPlaySlot(slot: KeyboardMessageSlot): void;
  /** Enables the per-row repeat toggle and interval input. */
  repeat?: KeyboardMacroPanelRepeatOptions;
  /** Estimated on-air duration of resolved slot text, for the TX progress bar. */
  getSlotDurationMs?(resolvedText: string): number;
  /**
   * `list` (default): one row per slot with the full resolved text.
   * `grid`: compact operate view, several slot buttons per row (F-key, label,
   * short preview; full text in a tooltip) sized to its content, for modes
   * whose layout also needs room for a terminal. The edit view stays a list.
   */
  layout?: 'list' | 'grid';
}

function getTxProgressStyle(durationMs: number): React.CSSProperties {
  return {
    animation: `voice-keyer-tx-progress ${Math.max(800, durationMs + TX_PROGRESS_OVERHEAD_MS)}ms linear forwards`,
  };
}

function getRemainingSeconds(nextRunAt: number | null, intervalSec: number): number | null {
  if (!nextRunAt) return null;
  return Math.min(intervalSec, Math.max(0, Math.ceil((nextRunAt - Date.now()) / 1000)));
}

function getWaitProgressStyle(nextRunAt: number, intervalSec: number): React.CSSProperties {
  const totalMs = Math.max(1000, intervalSec * 1000);
  const remainingMs = Math.min(totalMs, Math.max(0, nextRunAt - Date.now()));
  const elapsedMs = Math.max(0, totalMs - remainingMs);
  const startPercent = Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));

  return {
    '--voice-keyer-progress-scale': `${startPercent / 100}`,
    animation: `voice-keyer-wait-progress ${Math.max(1, remainingMs)}ms linear forwards`,
  } as React.CSSProperties;
}

const WaitProgress = React.memo(function WaitProgress({
  nextRunAt,
  intervalSec,
}: {
  nextRunAt: number;
  intervalSec: number;
}) {
  const style = useMemo(
    () => getWaitProgressStyle(nextRunAt, intervalSec),
    [intervalSec, nextRunAt],
  );

  return (
    <span
      key={`${nextRunAt}-${intervalSec}`}
      className="voice-keyer-wait-progress absolute inset-y-0 left-0 pointer-events-none bg-warning/25"
      style={style}
    />
  );
});

/** One-line plain preview of resolved slot text; missing placeholders stay highlighted. */
function CompactSegments({ segments }: { segments: MessageSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'text') return <React.Fragment key={index}>{segment.text}</React.Fragment>;
        if (segment.type === 'control') {
          return <span key={index} className="opacity-60">{segment.source.toUpperCase()}</span>;
        }
        return segment.resolved
          ? <React.Fragment key={index}>{segment.text}</React.Fragment>
          : <span key={index} className="rounded-sm bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-300">{segment.source.toUpperCase()}</span>;
      })}
    </>
  );
}

/**
 * Mode-agnostic message-slot panel for keyboard modes (CW, RTTY): header with
 * operate/edit tabs and operator select, mode-provided alerts and input area,
 * then the preset slots (F-key badge, play/stop, optional repeat) or their
 * editor (drag-to-swap, shortcut, text, label, clear).
 *
 * The panel does not register global hotkeys; pair it with
 * `useGlobalSlotHotkeys` gated on `macro.panelMode === 'operate'`.
 */
export function KeyboardMacroPanel({
  embedded = false,
  i18n,
  icon,
  statusChip,
  settingsContent,
  alerts,
  inputArea,
  macro,
  shortcuts,
  placeholders,
  isBusy,
  activeSlotId,
  activeSlotPhase,
  onPlaySlot,
  repeat,
  getSlotDurationMs,
  layout = 'list',
}: KeyboardMacroPanelProps) {
  const { t } = useTranslation();
  const tx = useModeText(i18n, KEYBOARD_MACRO_PANEL_TEXT_DEFAULTS);
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();
  const [txProgressRunId, setTxProgressRunId] = useState(0);
  const [, setCountdownTick] = useState(0);
  const [dragSlotId, setDragSlotId] = useState<string | null>(null);
  const [dragOverSlotId, setDragOverSlotId] = useState<string | null>(null);

  const { panel, panelLoading, panelMode, visibleSlots, callsign } = macro;
  const nextRunAt = repeat?.nextRunAt ?? null;
  const isGrid = layout === 'grid';
  // The grid sizes to its content in operate view; the edit list scrolls in a bounded box.
  const fitContent = isGrid && embedded;

  useEffect(() => {
    if (activeSlotPhase === 'transmitting') {
      setTxProgressRunId(value => value + 1);
    }
  }, [activeSlotPhase, activeSlotId]);

  useEffect(() => {
    if (activeSlotPhase !== 'waiting') {
      return undefined;
    }
    const timer = window.setInterval(() => setCountdownTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeSlotPhase]);

  const getShortcutLabel = useCallback((preset: KeyerShortcutPreset): string => {
    return preset === shortcuts.preferences.none ? (tx('shortcutNone') || '-') : preset;
  }, [shortcuts.preferences.none, tx]);

  const handleDragStart = useCallback((e: React.DragEvent, slotId: string) => {
    setDragSlotId(slotId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', slotId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragSlotId(null);
    setDragOverSlotId(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, slotId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverSlotId(prev => prev === slotId ? prev : slotId);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent, slotId: string) => {
    // Only clear if leaving to a child element (not leaving the slot entirely)
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (relatedTarget && (e.currentTarget as HTMLElement).contains(relatedTarget)) return;
    setDragOverSlotId(prev => prev === slotId ? null : prev);
  }, []);

  const { swapSlotShortcuts } = shortcuts;
  const { swapSlots } = macro;
  const handleDrop = useCallback((e: React.DragEvent, targetSlotId: string) => {
    e.preventDefault();
    setDragOverSlotId(null);
    const sourceSlotId = dragSlotId;
    if (!sourceSlotId || sourceSlotId === targetSlotId || !callsign) return;
    // F-key shortcuts follow the slot contents.
    swapSlotShortcuts(sourceSlotId, targetSlotId);
    void swapSlots(sourceSlotId, targetSlotId);
  }, [callsign, dragSlotId, swapSlotShortcuts, swapSlots]);

  const panelContent = (
    <>
      <div className={`flex items-center justify-between gap-2 ${embedded ? 'pb-3' : 'px-3 py-4'}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FontAwesomeIcon icon={icon} />
          </span>
          <span className="truncate text-sm font-semibold text-foreground">{tx('keyerTitle')}</span>
          {statusChip}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {settingsContent !== undefined && (
            <Popover placement="bottom-end">
              <PopoverTrigger>
                <Button
                  isIconOnly
                  size="sm"
                  variant="flat"
                  aria-label={tx('settings')}
                  className="h-7 min-w-7 rounded-md"
                >
                  <FontAwesomeIcon icon={faGear} className="text-xs" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 gap-3 p-3">
                {settingsContent}
              </PopoverContent>
            </Popover>
          )}
          <Tabs
            size="sm"
            variant="solid"
            selectedKey={panelMode}
            onSelectionChange={(key) => macro.setPanelMode(key as MacroPanelMode)}
            aria-label={tx('modeTabs')}
            classNames={{
              base: 'shrink-0',
              tabList: 'h-7 gap-0 p-0.5',
              tab: 'h-6 px-2 min-w-7',
              tabContent: 'text-xs',
            }}
          >
            <Tab
              key="operate"
              title={(
                <span className="flex items-center gap-1">
                  <FontAwesomeIcon icon={faTowerBroadcast} className="text-[10px]" />
                  <span className="hidden sm:inline">{tx('operateMode')}</span>
                </span>
              )}
            />
            <Tab
              key="edit"
              title={(
                <span className="flex items-center gap-1">
                  <FontAwesomeIcon icon={faPen} className="text-[10px]" />
                  <span className="hidden sm:inline">{tx('editMode')}</span>
                </span>
              )}
            />
          </Tabs>
          {operators.length > 0 && (
            <Select
              size="sm"
              variant="flat"
              aria-label={tx('operator')}
              selectedKeys={currentOperatorId ? [currentOperatorId] : []}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                if (selected) setCurrentOperatorId(selected);
              }}
              className="w-28"
              classNames={{ trigger: 'h-7 min-h-7 px-2', value: 'font-mono text-xs' }}
            >
              {operators.map((op) => (
                <SelectItem key={op.id} textValue={op.context?.myCall || op.id}>
                  {op.context?.myCall || op.id}
                </SelectItem>
              ))}
            </Select>
          )}
        </div>
      </div>

      <div className={`flex flex-col gap-3 ${fitContent ? '' : embedded ? 'flex-1 min-h-0 overflow-hidden' : 'px-3 pb-3'}`}>
        {alerts}
        {inputArea}

        <div className={embedded && !fitContent ? 'flex flex-1 min-h-0 flex-col' : undefined}>
          {(!isGrid || panelMode === 'edit') && (
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-default-600">
                {tx('presetMessages')}
              </span>
              {panelMode === 'edit' && (
                <div className="flex items-center gap-1">
                  <span className="mr-1 text-xs text-default-400">{panel?.slotCount ?? 0}</span>
                  <Tooltip content={tx('decreaseSlots')}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      onPress={() => void macro.changeSlotCount(-1)}
                      isDisabled={!macro.canDecreaseSlots}
                    >
                      <FontAwesomeIcon icon={faMinus} className="text-xs" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={tx('increaseSlots')}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      onPress={() => void macro.changeSlotCount(1)}
                      isDisabled={!macro.canIncreaseSlots}
                    >
                      <FontAwesomeIcon icon={faPlus} className="text-xs" />
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          )}

          {panelMode === 'edit' && placeholders.renderHint()}

          {panelLoading ? (
            <div className="py-4 text-center text-sm text-default-400">
              {t('common:loading', 'Loading...')}
            </div>
          ) : (
            <div className={
              isGrid && panelMode === 'operate'
                ? ''
                : `overflow-y-auto ${fitContent ? 'max-h-[min(28rem,55vh)] pr-1' : embedded ? 'flex-1 min-h-0 pr-1' : 'max-h-64'}`
            }>
              {visibleSlots.length === 0 ? (
                <div className="py-4 text-center text-sm text-default-400">
                  {tx('noMessages')}
                </div>
              ) : panelMode === 'operate' && isGrid ? (
                <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5" data-testid="macro-grid">
                  {visibleSlots.map((slot) => {
                    const active = activeSlotId === slot.id;
                    const transmitting = active && activeSlotPhase === 'transmitting';
                    const waiting = active && activeSlotPhase === 'waiting';
                    const intervalValue = clampRepeatIntervalSec(slot.repeatIntervalSec);
                    const remainingSeconds = waiting ? getRemainingSeconds(nextRunAt, intervalValue) : null;
                    const resolvedSlot = placeholders.resolve(slot.text);
                    const missing = resolvedSlot.unresolved.length > 0;
                    const durationMs = getSlotDurationMs?.(resolvedSlot.text);
                    const shortcutPreset = shortcuts.getShortcut(slot.id);
                    const rowDisabled = !slot.text || (isBusy && !active);
                    const label = slot.label.trim() || slot.text.trim();

                    const button = (
                      <Button
                        color={transmitting ? 'danger' : active ? 'warning' : 'primary'}
                        variant={transmitting ? 'solid' : active ? 'flat' : missing ? 'flat' : 'solid'}
                        className={`relative h-11 w-full min-w-0 flex-col items-stretch justify-center gap-0 overflow-hidden rounded-md px-2 py-1 ${missing && !active ? 'ring-1 ring-amber-400/70' : ''}`}
                        onPress={() => onPlaySlot(slot)}
                        isDisabled={rowDisabled}
                        data-missing={missing || undefined}
                      >
                        {transmitting && durationMs !== undefined && (
                          <span
                            key={`${slot.id}-${txProgressRunId}`}
                            className="voice-keyer-tx-progress absolute inset-y-0 left-0 pointer-events-none bg-white/25"
                            style={getTxProgressStyle(durationMs)}
                          />
                        )}
                        {waiting && nextRunAt && (
                          <WaitProgress nextRunAt={nextRunAt} intervalSec={intervalValue} />
                        )}
                        <span className={`relative z-10 flex w-full min-w-0 items-center gap-1.5 text-left ${repeat ? 'pr-5' : ''}`}>
                          <span className="shrink-0 rounded bg-black/15 px-1 font-mono text-[10px] font-semibold leading-4 dark:bg-white/15">
                            {getShortcutLabel(shortcutPreset)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5">
                            {slot.text ? label : tx('emptySlotHint')}
                          </span>
                          {missing && !active && (
                            <FontAwesomeIcon icon={faTriangleExclamation} className="shrink-0 text-[10px] text-amber-500" />
                          )}
                          {active && (
                            <span className={`shrink-0 ${waiting ? 'font-mono text-[11px] font-semibold tabular-nums' : 'text-[10px]'}`}>
                              {waiting
                                ? remainingSeconds !== null ? `${remainingSeconds}s` : 'TX'
                                : <FontAwesomeIcon icon={faStop} />}
                            </span>
                          )}
                        </span>
                        {slot.text && (
                          <span className="relative z-10 block w-full min-w-0 truncate text-left font-mono text-[10px] leading-4 opacity-75">
                            <CompactSegments segments={resolvedSlot.segments} />
                          </span>
                        )}
                      </Button>
                    );

                    return (
                      <div key={slot.id} className="relative min-w-0">
                        {slot.text ? (
                          <Tooltip
                            delay={400}
                            closeDelay={0}
                            placement="top"
                            content={(
                              <div className="max-w-xs py-1 font-mono text-xs leading-6">
                                {placeholders.renderSegments(resolvedSlot.segments)}
                              </div>
                            )}
                          >
                            {button}
                          </Tooltip>
                        ) : button}
                        {repeat && slot.text && (
                          <Button
                            isIconOnly
                            size="sm"
                            radius="sm"
                            color={slot.repeatEnabled ? 'warning' : 'default'}
                            variant={slot.repeatEnabled ? 'solid' : 'light'}
                            aria-label={tx('repeatToggle')}
                            aria-pressed={slot.repeatEnabled}
                            title={`${tx('repeatToggle')} · ${intervalValue}s`}
                            onPress={() => repeat.onToggle(slot)}
                            isDisabled={rowDisabled}
                            className={`absolute right-1 top-1 z-20 h-5 w-5 min-w-5 ${slot.repeatEnabled ? '' : 'text-white/70 hover:text-white data-[hover=true]:bg-white/20'} ${missing && !slot.repeatEnabled ? '!text-default-500' : ''}`}
                          >
                            <FontAwesomeIcon icon={slot.repeatEnabled ? faRepeat : faClock} className="text-[10px]" />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : panelMode === 'operate' ? (
                <div className="flex w-full flex-col gap-1.5">
                  {visibleSlots.map((slot) => {
                    const active = activeSlotId === slot.id;
                    const transmitting = active && activeSlotPhase === 'transmitting';
                    const waiting = active && activeSlotPhase === 'waiting';
                    const intervalValue = clampRepeatIntervalSec(slot.repeatIntervalSec);
                    const remainingSeconds = waiting ? getRemainingSeconds(nextRunAt, intervalValue) : null;
                    const resolvedSlot = placeholders.resolve(slot.text);
                    const durationMs = getSlotDurationMs?.(resolvedSlot.text);
                    const shortcutPreset = shortcuts.getShortcut(slot.id);
                    const activeToneClass = waiting
                      ? 'bg-warning-50 dark:bg-warning-950/20'
                      : active
                        ? 'bg-danger-50 dark:bg-danger-950/20'
                        : 'bg-content2';
                    const rowDisabled = !slot.text || (isBusy && !active);

                    return (
                      <div key={slot.id} className={`flex items-center gap-1.5 rounded-lg p-1.5 transition-colors ${activeToneClass}`}>
                        <Button
                          color={transmitting ? 'danger' : active ? 'warning' : 'primary'}
                          variant={transmitting ? 'solid' : active ? 'flat' : 'solid'}
                          className="relative h-9 min-w-0 flex-1 overflow-hidden rounded-md px-2"
                          onPress={() => onPlaySlot(slot)}
                          isDisabled={rowDisabled}
                        >
                          {transmitting && durationMs !== undefined && (
                            <span
                              key={`${slot.id}-${txProgressRunId}`}
                              className="voice-keyer-tx-progress absolute inset-y-0 left-0 pointer-events-none bg-white/25"
                              style={getTxProgressStyle(durationMs)}
                            />
                          )}
                          {waiting && nextRunAt && (
                            <WaitProgress
                              nextRunAt={nextRunAt}
                              intervalSec={intervalValue}
                            />
                          )}
                          <div className="relative z-10 flex w-full min-w-0 items-center gap-2 text-left">
                            <Chip
                              size="sm"
                              variant="flat"
                              color={active ? (waiting ? 'warning' : 'danger') : 'default'}
                              className="h-5 shrink-0 px-1 font-mono text-[10px] font-semibold"
                            >
                              {getShortcutLabel(shortcutPreset)}
                            </Chip>
                            <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold leading-6">
                              {slot.text
                                ? placeholders.renderSegments(resolvedSlot.segments)
                                : tx('emptySlotHint')}
                            </span>
                            <span className="max-w-[38%] shrink-0 truncate pr-3 text-right text-[11px] font-semibold opacity-90">
                              {slot.label}
                            </span>
                            {active && (
                              <span className={`shrink-0 opacity-90 ${waiting ? 'font-mono text-xs font-semibold tabular-nums' : 'text-[11px]'}`}>
                                {waiting
                                  ? remainingSeconds !== null ? `${remainingSeconds}s` : 'PTT'
                                  : <FontAwesomeIcon icon={faStop} />}
                              </span>
                            )}
                          </div>
                        </Button>
                        {repeat && (
                          <>
                            <Button
                              isIconOnly
                              size="sm"
                              color={slot.repeatEnabled ? 'warning' : 'default'}
                              variant={slot.repeatEnabled ? 'solid' : 'flat'}
                              aria-label={tx('repeatToggle')}
                              onPress={() => repeat.onToggle(slot)}
                              isDisabled={rowDisabled}
                              className="h-8 min-w-8 shrink-0 rounded-md"
                            >
                              <FontAwesomeIcon icon={slot.repeatEnabled ? faRepeat : faClock} className="text-xs" />
                            </Button>
                            <Input
                              type="number"
                              min={1}
                              max={300}
                              size="sm"
                              variant="flat"
                              value={String(intervalValue)}
                              aria-label={tx('repeatInterval')}
                              endContent={<span className="text-[11px] text-default-400">s</span>}
                              className="w-16 shrink-0"
                              classNames={{ inputWrapper: 'h-8 min-h-8 px-2', input: 'text-xs font-mono' }}
                              onValueChange={(value) => repeat.onIntervalChange(slot, value)}
                              isDisabled={rowDisabled}
                            />
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex w-full flex-col gap-1.5">
                  {visibleSlots.map((slot) => {
                    const shortcutPreset = shortcuts.getShortcut(slot.id);
                    const isDragging = dragSlotId === slot.id;
                    const isDragOver = dragOverSlotId === slot.id && dragSlotId !== slot.id;

                    return (
                      <div
                        key={slot.id}
                        draggable={!isBusy}
                        onDragStart={(e) => handleDragStart(e, slot.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleDragOver(e, slot.id)}
                        onDragLeave={(e) => handleDragLeave(e, slot.id)}
                        onDrop={(e) => handleDrop(e, slot.id)}
                        className={`flex items-center gap-1.5 rounded-lg p-1.5 transition-all duration-200 ${isGrid ? 'flex-wrap' : ''} ${
                          isDragging
                            ? 'opacity-40 scale-95 bg-primary-100 dark:bg-primary-900/20 ring-2 ring-primary-400'
                            : isDragOver
                              ? 'bg-content3 ring-2 ring-primary-300 shadow-md -translate-y-px'
                              : 'bg-content2'
                        }`}
                      >
                        <span className="flex items-center justify-center w-6 h-8 shrink-0 cursor-grab active:cursor-grabbing text-default-300 hover:text-default-500">
                          <FontAwesomeIcon icon={faGripVertical} className="text-xs" />
                        </span>
                        <Select
                          size="sm"
                          variant="flat"
                          aria-label={tx('shortcutSelectAria', { slot: slot.index })}
                          selectedKeys={[shortcutPreset]}
                          onSelectionChange={(keys) => {
                            const selected = Array.from(keys)[0] as KeyerShortcutPreset | undefined;
                            if (selected) shortcuts.setSlotShortcut(slot, selected);
                          }}
                          className="w-20 shrink-0"
                          classNames={{
                            trigger: 'h-8 min-h-8 rounded-full px-2 bg-default-100',
                            value: 'font-mono text-[10px] font-semibold',
                          }}
                          isDisabled={isBusy}
                        >
                          {shortcuts.preferences.presets.map((preset) => (
                            <SelectItem key={preset} textValue={getShortcutLabel(preset)}>
                              {getShortcutLabel(preset)}
                            </SelectItem>
                          ))}
                        </Select>
                        <Input
                          size="sm"
                          variant="flat"
                          value={slot.text}
                          aria-label={tx('messageText')}
                          maxLength={500}
                          className={isGrid ? 'min-w-[9rem] flex-1' : 'min-w-0 flex-1'}
                          classNames={{ input: 'font-mono text-xs font-semibold', inputWrapper: 'h-8 min-h-8 px-2' }}
                          placeholder={tx('messageTextPlaceholder', { callsign })}
                          onValueChange={(value) => macro.updateSlotLocal(slot.id, { text: value })}
                          onBlur={(event) => void macro.updateSlot(slot.id, { text: event.currentTarget.value })}
                          isDisabled={isBusy}
                        />
                        <Input
                          size="sm"
                          variant="flat"
                          value={slot.label}
                          aria-label={tx('messageLabel')}
                          maxLength={32}
                          className={isGrid ? 'w-24 shrink-0' : 'w-28 shrink-0'}
                          classNames={{ input: 'text-xs font-medium text-right', inputWrapper: 'h-8 min-h-8 pl-2 pr-4' }}
                          onValueChange={(value) => macro.updateSlotLocal(slot.id, { label: value })}
                          onBlur={(event) => void macro.updateSlot(slot.id, { label: event.currentTarget.value })}
                          isDisabled={isBusy}
                        />
                        {isGrid && repeat && (
                          <Input
                            type="number"
                            min={1}
                            max={300}
                            size="sm"
                            variant="flat"
                            value={String(clampRepeatIntervalSec(slot.repeatIntervalSec))}
                            aria-label={tx('repeatInterval')}
                            title={tx('repeatInterval')}
                            startContent={<FontAwesomeIcon icon={faRepeat} className="text-[10px] text-default-400" />}
                            endContent={<span className="text-[11px] text-default-400">s</span>}
                            className="w-20 shrink-0"
                            classNames={{ inputWrapper: 'h-8 min-h-8 px-2', input: 'text-xs font-mono' }}
                            onValueChange={(value) => repeat.onIntervalChange(slot, value)}
                            isDisabled={isBusy}
                          />
                        )}
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          color="danger"
                          aria-label={tx('clearSlot')}
                          onPress={() => void macro.deleteSlot(slot)}
                          isDisabled={!slot.text || isBusy}
                          className="h-8 min-w-8 shrink-0 rounded-md"
                        >
                          <FontAwesomeIcon icon={faEraser} className="text-xs" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className={`${fitContent ? '' : 'h-full min-h-0 overflow-hidden'} w-full rounded-xl bg-content1/80 p-3 shadow-sm ring-1 ring-default-200/60`}>
        <div className={fitContent ? 'flex flex-col' : 'flex h-full min-h-0 flex-col'}>
          {panelContent}
        </div>
      </div>
    );
  }

  return (
    <Card className="w-full">
      {panelContent}
    </Card>
  );
}
