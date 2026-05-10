import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Alert,
  Input,
  Textarea,
  Slider,
  Select,
  SelectItem,
  Tabs,
  Tab,
  Chip,
  Tooltip,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faPlay,
  faStop,
  faPen,
  faEraser,
  faPaperPlane,
  faRepeat,
  faClock,
  faWaveSquare,
  faTowerBroadcast,
  faPlug,
  faPlus,
  faMinus,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import {
  estimateCWMessageDurationMs,
  type CWKeyerBackend,
  type CWKeyerConfig,
  type CWMessagePanel,
  type CWMessageSlot,
} from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { useCWKeyer } from '../../hooks/useCWKeyer';
import { useOperators, useCurrentOperatorId, useRadioState } from '../../store/radioStore';
import { CWSidetone } from './CWSidetone';
import {
  getCWKeyerShortcutPresetsForCallsign,
  saveCWKeyerSlotShortcutPreset,
  matchesCWKeyerShortcut,
  CW_KEYER_SHORTCUT_PRESETS,
  CW_KEYER_SHORTCUT_NONE,
  CW_KEYER_SHORTCUT_CHANGED_EVENT,
} from '../../utils/cwKeyerShortcutPreferences';
import type { CWKeyerShortcutPreset, CWKeyerShortcutChangedDetail } from '../../utils/cwKeyerShortcutPreferences';

const WPM_MIN = 5;
const WPM_MAX = 60;
const TX_PROGRESS_OVERHEAD_MS = 650;

type CWPanelMode = 'operate' | 'edit';

const CW_ALERT_CLASS_NAMES = {
  base: '!flex-none !grow-0 py-2.5 px-3',
  mainWrapper: '!h-auto !min-h-0 justify-center',
  title: 'text-sm leading-5',
  description: 'text-xs leading-4',
  iconWrapper: 'w-8 h-8',
  alertIcon: 'w-5',
} as const;

interface CWKeyerPanelProps {
  embedded?: boolean;
}

function formatDuration(durationMs: number): string {
  if (!durationMs) return '--';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
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
    '--voice-keyer-progress-start': `${startPercent}%`,
    animation: `voice-keyer-wait-progress ${Math.max(1, remainingMs)}ms linear forwards`,
  } as React.CSSProperties;
}

const CWWaitProgress = React.memo(function CWWaitProgress({
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

export function CWKeyerPanel({ embedded = false }: CWKeyerPanelProps = {}) {
  const { t } = useTranslation();
  const { cwKeyerStatus, cwConfig, isCWMode, sendText, playMessage, stopMessage } = useCWKeyer();
  const radioState = useRadioState();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();

  const textInputRef = useRef<HTMLDivElement>(null);
  const slotUpdateTimersRef = useRef<Record<string, number>>({});
  const [textInput, setTextInput] = useState('');
  const [lastSentText, setLastSentText] = useState<string | null>(null);
  const [panel, setPanel] = useState<CWMessagePanel | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelMode, setPanelMode] = useState<CWPanelMode>('operate');
  const [slotShortcuts, setSlotShortcuts] = useState<Record<string, CWKeyerShortcutPreset>>({});
  const [loadedConfig, setLoadedConfig] = useState<CWKeyerConfig | null>(null);
  const [wpm, setWpm] = useState(cwConfig?.wpm ?? 20);
  const [txProgressRunId, setTxProgressRunId] = useState(0);
  const [, setCountdownTick] = useState(0);

  const effectiveConfig = cwConfig ?? loadedConfig;
  const backend: CWKeyerBackend = effectiveConfig?.backend ?? 'cat';
  const isSerialBackend = backend === 'serial';
  const serialKeyPort = effectiveConfig?.keyPort?.trim() ?? '';
  const showSerialPortAlert = isSerialBackend && !serialKeyPort;
  const radioConnected = radioState.state.radioConnected;
  const radioConfigType = radioState.state.radioConfig?.type;
  const isHamlibRadioConfig = radioConfigType === 'serial' || radioConfigType === 'network';
  const catUnavailableReason = !radioConnected
    ? t('radio:cw.catUnavailableDisconnected', 'Connect a Hamlib radio before using CAT CW.')
    : !isHamlibRadioConfig
      ? t('radio:cw.catUnavailableHamlibOnly', 'CAT CW currently supports Hamlib serial or network radio connections only.')
      : cwKeyerStatus?.backend === 'cat' && cwKeyerStatus.backendAvailable === false
        ? cwKeyerStatus.backendError
        : null;
  const showCatAlert = backend === 'cat' && Boolean(catUnavailableReason);

  const myCallsign = operators.find(o => o.id === currentOperatorId)?.context?.myCall?.trim() || '';
  const isActive = cwKeyerStatus?.active ?? false;
  const statusMode = cwKeyerStatus?.mode ?? 'idle';
  const activeSlotId = (statusMode === 'playing' || statusMode === 'repeat-waiting')
    ? cwKeyerStatus?.messageId ?? null
    : null;
  const isManualTextPlaying = isActive && statusMode === 'playing' && !cwKeyerStatus?.messageId;

  useEffect(() => {
    if (!isCWMode) return;
    let cancelled = false;
    api.getCWKeyerConfig()
      .then((resp) => {
        if (!cancelled) setLoadedConfig(resp.config);
      })
      .catch(() => {
        // Keep default CAT mode if the config endpoint is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [isCWMode]);

  useEffect(() => {
    if (effectiveConfig) {
      setWpm(effectiveConfig.wpm);
    }
  }, [effectiveConfig]);

  useEffect(() => {
    if (isActive && statusMode === 'playing') {
      setTxProgressRunId(value => value + 1);
    }
  }, [isActive, statusMode, cwKeyerStatus?.messageId]);

  useEffect(() => {
    if (!(isActive && statusMode === 'repeat-waiting')) {
      return undefined;
    }
    const timer = window.setInterval(() => setCountdownTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, statusMode]);

  const loadPanel = useCallback(async () => {
    if (!myCallsign) {
      setPanel(null);
      return;
    }
    setPanelLoading(true);
    try {
      const resp = await api.getCWMessagePanel(myCallsign);
      setPanel(resp.panel);
    } catch {
      // Keep the keyer usable even if the preset panel cannot be loaded temporarily.
    } finally {
      setPanelLoading(false);
    }
  }, [myCallsign]);

  useEffect(() => {
    if (isCWMode) {
      void loadPanel();
    }
  }, [isCWMode, loadPanel]);

  const visibleSlots = useMemo(() => panel?.slots.slice(0, panel.slotCount) ?? [], [panel]);
  const canIncreaseSlots = (panel?.slotCount ?? 0) < (panel?.maxSlotCount ?? 12);
  const canDecreaseSlots = (panel?.slotCount ?? 3) > 3;

  useEffect(() => {
    if (!myCallsign || !panel?.slots) {
      setSlotShortcuts({});
      return;
    }
    const presets = getCWKeyerShortcutPresetsForCallsign(myCallsign, panel.slots);
    setSlotShortcuts(presets);
  }, [myCallsign, panel?.slots]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CWKeyerShortcutChangedDetail>).detail;
      if (!detail || detail.callsign !== myCallsign?.trim().toUpperCase()) return;
      setSlotShortcuts(prev => ({ ...prev, [detail.slotId]: detail.preset }));
    };
    window.addEventListener(CW_KEYER_SHORTCUT_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CW_KEYER_SHORTCUT_CHANGED_EVENT, handler);
  }, [myCallsign]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.key === 'Escape' && isActive) {
        event.preventDefault();
        stopMessage();
        return;
      }

      if (!isCWMode || !myCallsign || panelMode !== 'operate') return;

      const slot = visibleSlots.find(candidate =>
        matchesCWKeyerShortcut(event.code, slotShortcuts[candidate.id] ?? CW_KEYER_SHORTCUT_NONE),
      );

      if (!slot || !slot.text || isActive) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      playMessage(myCallsign, slot.id, slot.repeatEnabled);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
  }, [isActive, isCWMode, myCallsign, panelMode, playMessage, slotShortcuts, stopMessage, visibleSlots]);

  useEffect(() => () => {
    Object.values(slotUpdateTimersRef.current).forEach(timer => window.clearTimeout(timer));
    slotUpdateTimersRef.current = {};
  }, []);

  const updateSlotLocal = useCallback((slotId: string, update: Partial<Pick<CWMessageSlot, 'label' | 'text' | 'repeatEnabled' | 'repeatIntervalSec'>>) => {
    setPanel(current => current ? {
      ...current,
      slots: current.slots.map(item => item.id === slotId ? { ...item, ...update } : item),
    } : current);
  }, []);

  const updateSlot = useCallback(async (
    slotId: string,
    update: Partial<Pick<CWMessageSlot, 'label' | 'text' | 'repeatEnabled' | 'repeatIntervalSec'>>,
  ): Promise<CWMessagePanel | null> => {
    if (!myCallsign) return null;
    try {
      const resp = await api.updateCWMessageSlot(myCallsign, slotId, update);
      setPanel(resp.panel);
      return resp.panel;
    } catch (err) {
      addToast({
        title: t('common:error'),
        description: String(err),
        color: 'danger',
      });
      return null;
    }
  }, [myCallsign, t]);

  const queueSlotUpdate = useCallback((slotId: string, update: Partial<Pick<CWMessageSlot, 'repeatEnabled' | 'repeatIntervalSec'>>) => {
    const timers = slotUpdateTimersRef.current;
    if (timers[slotId]) window.clearTimeout(timers[slotId]);
    timers[slotId] = window.setTimeout(() => {
      delete timers[slotId];
      void updateSlot(slotId, update);
    }, 350);
  }, [updateSlot]);

  const updateSlotShortcut = useCallback((slot: CWMessageSlot, preset: CWKeyerShortcutPreset) => {
    if (!myCallsign) return;
    const nextShortcuts = { ...slotShortcuts };
    const changes: Array<{ slotId: string; preset: CWKeyerShortcutPreset }> = [];

    if (preset !== CW_KEYER_SHORTCUT_NONE) {
      for (const candidate of panel?.slots ?? []) {
        if (candidate.id !== slot.id && nextShortcuts[candidate.id] === preset) {
          nextShortcuts[candidate.id] = CW_KEYER_SHORTCUT_NONE;
          changes.push({ slotId: candidate.id, preset: CW_KEYER_SHORTCUT_NONE });
        }
      }
    }

    nextShortcuts[slot.id] = preset;
    changes.push({ slotId: slot.id, preset });

    setSlotShortcuts(nextShortcuts);
    for (const change of changes) {
      saveCWKeyerSlotShortcutPreset(myCallsign, change.slotId, change.preset);
    }
  }, [myCallsign, panel?.slots, slotShortcuts]);

  const getShortcutLabel = useCallback((preset: CWKeyerShortcutPreset): string => {
    return preset === CW_KEYER_SHORTCUT_NONE ? (t('radio:cw.shortcutNone') || '-') : preset;
  }, [t]);

  const handleSendText = useCallback((text = textInput) => {
    const trimmed = text.trim();
    if (!trimmed || (isActive && statusMode !== 'idle')) return;
    sendText(trimmed, myCallsign || undefined);
    setLastSentText(trimmed);
    if (text === textInput) {
      setTextInput('');
      requestAnimationFrame(() => {
        const el = textInputRef.current;
        if (el) {
          const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
          (input as HTMLInputElement)?.focus();
        }
      });
    }
  }, [isActive, myCallsign, sendText, statusMode, textInput]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isActive && statusMode !== 'idle') return;
      handleSendText();
    }
  };

  const handleWpmChange = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    setWpm(v);
  };

  const handleWpmChangeEnd = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    void api.updateCWKeyerConfig({ wpm: v }).then((resp) => setLoadedConfig(resp.config));
  };

  const handleBackendChange = (key: React.Key) => {
    const nextBackend: CWKeyerBackend = key === 'serial' ? 'serial' : 'cat';
    setLoadedConfig((prev) => ({
      backend: nextBackend,
      keyPort: prev?.keyPort ?? effectiveConfig?.keyPort ?? '',
      keyMethod: prev?.keyMethod ?? effectiveConfig?.keyMethod ?? 'dtr',
      wpm: prev?.wpm ?? effectiveConfig?.wpm ?? wpm,
    }));
    void api.updateCWKeyerConfig({ backend: nextBackend })
      .then((resp) => setLoadedConfig(resp.config))
      .catch((err) => {
        addToast({
          title: t('common:error'),
          description: String(err),
          color: 'danger',
        });
      });
  };

  const handleSlotCountChange = async (delta: number) => {
    if (!myCallsign || !panel) return;
    const newCount = panel.slotCount + delta;
    try {
      const resp = await api.updateCWMessagePanel(myCallsign, { slotCount: newCount });
      setPanel(resp.panel);
    } catch (err) {
      addToast({
        title: t('common:error'),
        description: String(err),
        color: 'danger',
      });
    }
  };

  const handleDeleteSlot = async (slot: CWMessageSlot) => {
    if (!myCallsign) return;
    try {
      const resp = await api.deleteCWMessageSlot(myCallsign, slot.id);
      setPanel(resp.panel);
    } catch (err) {
      addToast({
        title: t('common:error'),
        description: String(err),
        color: 'danger',
      });
    }
  };

  const handlePlay = (slot: CWMessageSlot) => {
    if (!myCallsign || !slot.text) return;
    if (activeSlotId === slot.id) {
      stopMessage();
      return;
    }
    if (isActive) return;
    playMessage(myCallsign, slot.id, slot.repeatEnabled);
  };

  const handleRepeatToggle = async (slot: CWMessageSlot) => {
    const repeatEnabled = !slot.repeatEnabled;
    updateSlotLocal(slot.id, { repeatEnabled });
    const updatedPanel = await updateSlot(slot.id, { repeatEnabled });
    if (!updatedPanel) {
      updateSlotLocal(slot.id, { repeatEnabled: slot.repeatEnabled });
      return;
    }
    if (repeatEnabled && slot.text && !isActive) {
      playMessage(myCallsign, slot.id, true, false);
    } else if (!repeatEnabled && activeSlotId === slot.id) {
      stopMessage();
    }
  };

  const handleRepeatIntervalChange = (slot: CWMessageSlot, value: string) => {
    const repeatIntervalSec = Math.max(1, Math.min(300, Math.round(Number(value) || 1)));
    updateSlotLocal(slot.id, { repeatIntervalSec });
    queueSlotUpdate(slot.id, { repeatIntervalSec });
  };

  if (!isCWMode) return null;

  const lastSentDurationMs = estimateCWMessageDurationMs(lastSentText ?? '', wpm);

  const panelContent = (
    <>
      <div className={`flex items-center justify-between gap-2 ${embedded ? 'px-1 py-3' : 'px-3 py-4'}`}>
        <div className="flex min-w-0 items-center gap-2">
          <FontAwesomeIcon icon={faWaveSquare} className="text-primary" />
          <span className="font-semibold">{t('radio:cw.title', 'CW')}</span>
          {isActive && (
            <Chip size="sm" variant="flat" color={statusMode === 'repeat-waiting' ? 'warning' : 'success'}>
              {statusMode === 'keying' ? 'KEYING' : statusMode === 'playing' ? 'TX' : statusMode}
            </Chip>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Tabs
            size="sm"
            variant="solid"
            selectedKey={panelMode}
            onSelectionChange={(key) => setPanelMode(key as CWPanelMode)}
            aria-label={t('radio:cw.modeTabs', 'CW keyer mode')}
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
                  <span className="hidden sm:inline">{t('radio:cw.operateMode', 'Transmit')}</span>
                </span>
              )}
            />
            <Tab
              key="edit"
              title={(
                <span className="flex items-center gap-1">
                  <FontAwesomeIcon icon={faPen} className="text-[10px]" />
                  <span className="hidden sm:inline">{t('radio:cw.editMode', 'Edit')}</span>
                </span>
              )}
            />
          </Tabs>
          {operators.length > 0 && (
            <Select
              size="sm"
              variant="flat"
              aria-label={t('radio:cw.operator', 'Operator')}
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

      <CWSidetone />

      <div className={`flex flex-col gap-3 ${embedded ? 'flex-1 min-h-0 overflow-hidden px-1 pb-1' : 'px-3 pb-3'}`}>
        {showSerialPortAlert && (
          <Alert
            color="warning"
            variant="flat"
            title={t('radio:cw.serialPortMissingTitle', 'CW serial port is not configured')}
            classNames={CW_ALERT_CLASS_NAMES}
          >
            <span className="text-xs leading-4">
              {t('radio:cw.serialPortMissingBody', 'Serial keying is selected, but no CW key port is configured. Set the CW key port in the radio profile before using the serial keyer.')}
            </span>
          </Alert>
        )}

        {showCatAlert && (
          <Alert
            color="warning"
            variant="flat"
            title={t('radio:cw.catUnavailableTitle', 'CAT CW is not available')}
            classNames={CW_ALERT_CLASS_NAMES}
          >
            <span className="text-xs leading-4">
              {catUnavailableReason || t('radio:cw.catUnavailableBody', 'Connect a Hamlib radio that supports CAT Morse sending before using this backend.')}
            </span>
          </Alert>
        )}

        <div className="flex gap-2">
          <Input
            ref={textInputRef}
            value={textInput}
            onValueChange={setTextInput}
            onKeyDown={handleKeyDown}
            placeholder={t('radio:cw.textInputPlaceholder', 'Enter CW text...')}
            className="flex-1"
            endContent={
              <Button
                isIconOnly
                size="sm"
                variant="light"
                onPress={() => handleSendText()}
                isDisabled={!textInput.trim() || (isActive && statusMode !== 'idle')}
                aria-label={t('radio:cw.send', 'Send')}
              >
                <FontAwesomeIcon icon={faPaperPlane} />
              </Button>
            }
          />
        </div>

        {lastSentText && (
          <div className={`rounded-lg p-2 transition-colors ${isManualTextPlaying ? 'bg-danger-50 dark:bg-danger-950/20' : 'bg-content2'}`}>
            <Button
              color={isManualTextPlaying ? 'danger' : 'default'}
              variant={isManualTextPlaying ? 'solid' : 'flat'}
              className={`relative h-12 w-full overflow-hidden rounded-md px-2 transition-colors ${isManualTextPlaying ? '' : 'hover:bg-primary-50 dark:hover:bg-primary-500/10'}`}
              onPress={() => isManualTextPlaying ? stopMessage() : handleSendText(lastSentText)}
              isDisabled={isActive && !isManualTextPlaying}
            >
              {isManualTextPlaying && (
                <span
                  key={`manual-${txProgressRunId}`}
                  className="voice-keyer-tx-progress absolute inset-y-0 left-0 pointer-events-none bg-white/25"
                  style={getTxProgressStyle(lastSentDurationMs)}
                />
              )}
              <div className="relative z-10 flex w-full items-center gap-2 text-left">
                <Chip size="sm" color={isManualTextPlaying ? 'danger' : 'default'} variant="flat" className="shrink-0">
                  {isManualTextPlaying ? 'TX' : t('radio:cw.lastSent', 'Last')}
                </Chip>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{lastSentText}</span>
                <span className="shrink-0 text-[11px] opacity-80">
                  {isManualTextPlaying ? <FontAwesomeIcon icon={faStop} /> : formatDuration(lastSentDurationMs)}
                </span>
              </div>
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-lg border border-default-200 bg-default-50 px-3 py-3">
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 whitespace-nowrap text-xs text-default-600">{t('radio:cw.wpm', 'WPM')}</span>
            <Slider
              size="sm"
              step={1}
              minValue={WPM_MIN}
              maxValue={WPM_MAX}
              value={wpm}
              onChange={handleWpmChange}
              onChangeEnd={handleWpmChangeEnd}
              className="flex-1"
              aria-label={t('radio:cw.wpm', 'WPM')}
            />
            <span className="w-10 text-right font-mono text-xs text-default-800">{wpm}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="w-20 shrink-0 text-xs text-default-600">{t('radio:cw.backendTabs', 'CW backend')}</span>
            <Tabs
              size="sm"
              variant="solid"
              selectedKey={backend}
              onSelectionChange={handleBackendChange}
              aria-label={t('radio:cw.backendTabs', 'CW backend')}
              classNames={{
                base: 'shrink-0',
                tabList: 'h-7 gap-0 rounded-lg p-0.5',
                cursor: 'rounded-md',
                tab: 'h-6 min-w-7 rounded-md px-2',
                tabContent: 'text-xs',
              }}
            >
              <Tab
                key="cat"
                title={(
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faTowerBroadcast} className="text-[10px]" />
                    <span>{t('radio:cw.backendCat', 'Radio keyer')}</span>
                  </span>
                )}
              />
              <Tab
                key="serial"
                title={(
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faPlug} className="text-[10px]" />
                    <span>{t('radio:cw.backendSerial', 'Key jack')}</span>
                  </span>
                )}
              />
            </Tabs>
          </div>
        </div>

        <div className={embedded ? 'flex flex-1 min-h-0 flex-col' : undefined}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-default-600">
              {t('radio:cw.presetMessages', 'Presets')}
            </span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs text-default-400">{panel?.slotCount ?? 0}</span>
              <Tooltip content={t('radio:cw.decreaseSlots', 'Remove slot')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  onPress={() => handleSlotCountChange(-1)}
                  isDisabled={!canDecreaseSlots}
                >
                  <FontAwesomeIcon icon={faMinus} className="text-xs" />
                </Button>
              </Tooltip>
              <Tooltip content={t('radio:cw.increaseSlots', 'Add slot')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  onPress={() => handleSlotCountChange(1)}
                  isDisabled={!canIncreaseSlots}
                >
                  <FontAwesomeIcon icon={faPlus} className="text-xs" />
                </Button>
              </Tooltip>
            </div>
          </div>

          {panelLoading ? (
            <div className="py-4 text-center text-sm text-default-400">
              {t('common:loading', 'Loading...')}
            </div>
          ) : (
            <div className={`overflow-y-auto ${embedded ? 'flex-1 min-h-0 pr-1' : 'max-h-64'}`}>
              {visibleSlots.length === 0 ? (
                <div className="py-4 text-center text-sm text-default-400">
                  {t('radio:cw.noMessages', 'No messages configured')}
                </div>
              ) : panelMode === 'operate' ? (
                <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-2">
                  {visibleSlots.map((slot) => {
                    const active = activeSlotId === slot.id;
                    const transmitting = active && statusMode === 'playing';
                    const waiting = active && statusMode === 'repeat-waiting';
                    const intervalValue = Math.max(1, Math.min(300, Math.round(Number(slot.repeatIntervalSec) || 1)));
                    const remainingSeconds = waiting ? getRemainingSeconds(cwKeyerStatus?.nextRunAt ?? null, intervalValue) : null;
                    const durationMs = estimateCWMessageDurationMs(slot.text, wpm);
                    const shortcutPreset = slotShortcuts[slot.id] ?? CW_KEYER_SHORTCUT_NONE;
                    const activeToneClass = waiting
                      ? 'bg-warning-50 dark:bg-warning-950/20'
                      : active
                        ? 'bg-danger-50 dark:bg-danger-950/20'
                        : 'bg-content2';

                    return (
                      <div key={slot.id} className={`rounded-lg p-2 transition-colors ${activeToneClass}`}>
                        <Button
                          color={transmitting ? 'danger' : active ? 'warning' : 'primary'}
                          variant={transmitting ? 'solid' : active ? 'flat' : 'solid'}
                          className="relative h-16 w-full overflow-hidden rounded-md px-2 pt-1 pb-1.5"
                          onPress={() => handlePlay(slot)}
                          isDisabled={!slot.text || (isActive && !active)}
                        >
                          {transmitting && (
                            <span
                              key={`${slot.id}-${txProgressRunId}`}
                              className="voice-keyer-tx-progress absolute inset-y-0 left-0 pointer-events-none bg-white/25"
                              style={getTxProgressStyle(durationMs)}
                            />
                          )}
                          {waiting && cwKeyerStatus?.nextRunAt && (
                            <CWWaitProgress
                              nextRunAt={cwKeyerStatus.nextRunAt}
                              intervalSec={intervalValue}
                            />
                          )}
                          <div className="relative z-10 flex w-full flex-col items-start gap-1 text-left">
                            <div className="flex w-full items-center justify-between gap-1">
                              <span className="font-mono text-xs font-semibold">
                                {getShortcutLabel(shortcutPreset)}
                              </span>
                              <span className={`min-w-0 truncate text-right opacity-90 ${waiting ? 'font-mono text-sm font-semibold tabular-nums' : 'text-[11px] font-semibold'}`}>
                                {waiting
                                  ? remainingSeconds !== null ? `${remainingSeconds}s` : 'PTT'
                                  : transmitting ? <FontAwesomeIcon icon={faStop} /> : slot.label}
                              </span>
                            </div>
                            <span className="max-w-full truncate text-sm font-semibold">
                              {slot.text || t('radio:cw.emptySlotHint', 'Edit this slot first')}
                            </span>
                          </div>
                        </Button>
                        <div className="mt-2 flex items-center gap-1">
                          <Button
                            isIconOnly
                            size="sm"
                            color={slot.repeatEnabled ? 'warning' : 'default'}
                            variant={slot.repeatEnabled ? 'solid' : 'flat'}
                            aria-label={t('radio:cw.repeatToggle', 'Repeat toggle')}
                            onPress={() => void handleRepeatToggle(slot)}
                            isDisabled={!slot.text || (isActive && !active)}
                            className="h-7 min-w-7 rounded-md"
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
                            aria-label={t('radio:cw.repeatInterval', 'Interval (s)')}
                            endContent={<span className="text-[11px] text-default-400">s</span>}
                            classNames={{ inputWrapper: 'h-7 min-h-7 px-2', input: 'text-xs font-mono' }}
                            onValueChange={(value) => handleRepeatIntervalChange(slot, value)}
                            isDisabled={!slot.text || (isActive && !active)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-2">
                  {visibleSlots.map((slot) => {
                    const shortcutPreset = slotShortcuts[slot.id] ?? CW_KEYER_SHORTCUT_NONE;

                    return (
                      <div key={slot.id} className="rounded-lg bg-content2 p-2 transition-colors">
                        <div className="flex items-center justify-between gap-2">
                          <Select
                            size="sm"
                            variant="flat"
                            aria-label={t('radio:cw.shortcutSelectAria', { slot: slot.index })}
                            selectedKeys={[shortcutPreset]}
                            onSelectionChange={(keys) => {
                              const selected = Array.from(keys)[0] as CWKeyerShortcutPreset | undefined;
                              if (selected) updateSlotShortcut(slot, selected);
                            }}
                            className="w-20"
                            classNames={{ trigger: 'h-7 min-h-7 px-2', value: 'font-mono text-xs' }}
                            isDisabled={isActive}
                          >
                            {CW_KEYER_SHORTCUT_PRESETS.map((preset) => (
                              <SelectItem key={preset} textValue={getShortcutLabel(preset)}>
                                {getShortcutLabel(preset)}
                              </SelectItem>
                            ))}
                          </Select>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            color="danger"
                            aria-label={t('radio:cw.clearSlot', 'Clear')}
                            onPress={() => void handleDeleteSlot(slot)}
                            isDisabled={!slot.text || isActive}
                            className="h-7 min-w-7 rounded-md"
                          >
                            <FontAwesomeIcon icon={faEraser} className="text-xs" />
                          </Button>
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          <FontAwesomeIcon icon={faPen} className="text-[10px] text-default-400" />
                          <Input
                            size="sm"
                            variant="flat"
                            value={slot.label}
                            aria-label={t('radio:cw.messageLabel', 'Label')}
                            maxLength={32}
                            classNames={{ input: 'text-xs font-medium', inputWrapper: 'h-7 min-h-7 px-2' }}
                            onValueChange={(value) => updateSlotLocal(slot.id, { label: value })}
                            onBlur={(event) => void updateSlot(slot.id, { label: event.currentTarget.value })}
                            isDisabled={isActive}
                          />
                        </div>
                        <Textarea
                          size="sm"
                          variant="flat"
                          value={slot.text}
                          aria-label={t('radio:cw.messageText', 'Text')}
                          maxLength={500}
                          minRows={2}
                          className="mt-2"
                          classNames={{ input: 'font-mono text-xs leading-4' }}
                          placeholder={t('radio:cw.messageTextPlaceholder', 'CQ CQ CQ DE {{callsign}}', { callsign: myCallsign })}
                          onValueChange={(value) => updateSlotLocal(slot.id, { text: value })}
                          onBlur={(event) => void updateSlot(slot.id, { text: event.currentTarget.value })}
                          isDisabled={isActive}
                        />
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
      <div className="h-full min-h-0 w-full overflow-hidden rounded-lg border border-default-200 bg-default-50 px-2 pb-2 pt-0 transition-colors dark:border-default-100 dark:bg-default-100/50">
        <div className="flex h-full min-h-0 flex-col">
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
