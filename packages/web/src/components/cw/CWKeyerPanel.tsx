import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Alert,
  Input,
  Slider,
  Tabs,
  Tab,
  Chip,
  Switch,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faStop,
  faPaperPlane,
  faWaveSquare,
  faTowerBroadcast,
  faPlug,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import {
  estimateCWMessageDurationMs,
  type CWKeyerBackend,
  type CWKeyerConfig,
  type CWMessageSlot,
  type CWPlaceholderValues,
} from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { useCWKeyer } from '../../hooks/useCWKeyer';
import { useMacroPanel, type MacroPanelAdapter } from '../../hooks/useMacroPanel';
import { useSlotShortcuts } from '../../hooks/useSlotShortcuts';
import { useGlobalSlotHotkeys } from '../../hooks/useGlobalSlotHotkeys';
import { useOperators, useCurrentOperatorId, useRadioConnectionState } from '../../store/radioStore';
import { CWSidetone, type CWSidetoneHandle } from './CWSidetone';
import { cwKeyerShortcutPreferences } from '../../utils/cwKeyerShortcutPreferences';
import { useCWQSODraft } from '../../store/cwQsoDraftStore';
import { KeyboardMacroPanel, type MacroSlotPhase } from '../keyboard-mode/KeyboardMacroPanel';
import { useMessagePlaceholders } from '../keyboard-mode/useMessagePlaceholders';
import type { KeyboardModeI18n } from '../keyboard-mode/modeText';

const WPM_MIN = 5;
const WPM_MAX = 60;
const TX_PROGRESS_OVERHEAD_MS = 650;
const CW_TEXT_INPUT_MODE_STORAGE_KEY = 'tx5dr_cw_text_input_mode';
const REALTIME_CW_CHARACTER_PATTERN = /^[A-Z0-9.,?/=@\-+:;'"!&()_$]$/;

type CWTextInputMode = 'buffered' | 'realtime';

const CW_ALERT_CLASS_NAMES = {
  base: '!flex-none !grow-0 py-2.5 px-3',
  mainWrapper: '!h-auto !min-h-0 justify-center',
  title: 'text-sm leading-5',
  description: 'text-xs leading-4',
  iconWrapper: 'w-8 h-8',
  alertIcon: 'w-5',
} as const;

/** CW keeps its `radio:cw.*` keys; only CW-worded defaults differ from the shared ones. */
const CW_KEYER_I18N: KeyboardModeI18n = {
  prefix: 'radio:cw',
  defaults: {
    keyerTitle: 'CW Keyer',
    modeTabs: 'CW keyer mode',
    placeholderMissingToast: 'Fill in {{placeholders}} before sending this CW message.',
    placeholderMissingTitle: 'Missing CW placeholder value',
  },
};

const CW_MESSAGE_PANEL_ADAPTER: MacroPanelAdapter = {
  getPanel: async (callsign) => (await api.getCWMessagePanel(callsign)).panel,
  updatePanel: async (callsign, update) => (await api.updateCWMessagePanel(callsign, update)).panel,
  updateSlot: async (callsign, slotId, update) => (await api.updateCWMessageSlot(callsign, slotId, update)).panel,
  deleteSlot: async (callsign, slotId) => (await api.deleteCWMessageSlot(callsign, slotId)).panel,
  swapSlots: async (callsign, slotIdA, slotIdB) => (await api.swapCWMessageSlots(callsign, slotIdA, slotIdB)).panel,
};

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

export function CWKeyerPanel({ embedded = false }: CWKeyerPanelProps = {}) {
  const { t } = useTranslation();
  const { cwKeyerStatus, cwConfig, isCWMode, sendText, playMessage, stopMessage } = useCWKeyer();
  const radioState = useRadioConnectionState();
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const { hisCallsign, trst, rrst } = useCWQSODraft();

  const textInputRef = useRef<HTMLInputElement>(null);
  const realtimeInputQueueRef = useRef<Array<{ text: string; gapUnits: number }>>([]);
  const realtimePendingWordGapRef = useRef(false);
  const realtimeHasQueuedOrSentRef = useRef(false);
  const realtimeBlockedUntilRef = useRef(0);
  const [textInput, setTextInput] = useState('');
  const [lastSentText, setLastSentText] = useState<string | null>(null);
  const [textInputMode, setTextInputMode] = useState<CWTextInputMode>(() => {
    try {
      return localStorage.getItem(CW_TEXT_INPUT_MODE_STORAGE_KEY) === 'realtime' ? 'realtime' : 'buffered';
    } catch { return 'buffered'; }
  });
  const [realtimeQueueVersion, setRealtimeQueueVersion] = useState(0);
  const [loadedConfig, setLoadedConfig] = useState<CWKeyerConfig | null>(null);
  const [wpm, setWpm] = useState(cwConfig?.wpm ?? 20);
  const [txProgressRunId, setTxProgressRunId] = useState(0);
  const [sidetoneEnabled, setSidetoneEnabled] = useState(() => {
    try {
      return localStorage.getItem('tx5dr_cw_sidetone_enabled') !== 'false';
    } catch { return true; }
  });
  const [sidetoneFrequency, setSidetoneFrequency] = useState(() => {
    try {
      const saved = localStorage.getItem('tx5dr_cw_sidetone_frequency');
      return saved ? Math.max(300, Math.min(1200, Number(saved))) : 700;
    } catch { return 700; }
  });
  const [sidetoneVolume, setSidetoneVolume] = useState(() => {
    try {
      const saved = localStorage.getItem('tx5dr_cw_sidetone_volume');
      return saved ? Math.max(0.05, Math.min(1, Number(saved))) : 0.3;
    } catch { return 0.3; }
  });
  const sidetoneRef = useRef<CWSidetoneHandle>(null);

  const effectiveConfig = cwConfig ?? loadedConfig;
  const backend: CWKeyerBackend = effectiveConfig?.backend ?? 'cat';
  const isSerialBackend = backend === 'serial';
  const serialKeyPort = effectiveConfig?.keyPort?.trim() ?? '';
  const showSerialPortAlert = isSerialBackend && !serialKeyPort;
  const radioConnected = radioState.radioConnected;
  const radioConfigType = radioState.radioConfig?.type;
  const isRadioKeyerCapableConfig = radioConfigType === 'serial'
    || radioConfigType === 'network'
    || radioConfigType === 'icom-wlan'
    || radioConfigType === 'tci';
  const catBackendError = cwKeyerStatus?.backend === 'cat' && cwKeyerStatus.backendAvailable === false
    ? cwKeyerStatus.backendError
    : null;
  const catUnsupportedSendMorse = catBackendError?.includes('SEND_MORSE') === true
    || catBackendError?.includes('CW 0x17') === true
    || catBackendError?.includes('CW text sending support') === true;
  const catUnavailableReason = !radioConnected
    ? t('radio:cw.catUnavailableDisconnected', 'Connect a radio before using CAT CW.')
    : !isRadioKeyerCapableConfig
      ? t('radio:cw.catUnavailableHamlibOnly', 'CAT CW currently supports Hamlib serial/network, ICOM WLAN, or TCI radio connections only.')
      : catUnsupportedSendMorse
        ? t('radio:cw.catUnsupportedSendMorse', 'The radio does not report CAT/radio CW text sending support. Use Key jack instead, or verify Hamlib SEND_MORSE / ICOM CI-V CW support.')
        : catBackendError;
  const showCatAlert = backend === 'cat' && Boolean(catUnavailableReason);

  const myCallsign = operators.find(o => o.id === currentOperatorId)?.context?.myCall?.trim() || '';
  const placeholderValues = useMemo<CWPlaceholderValues>(() => ({
    myCall: myCallsign || undefined,
    hisCall: hisCallsign || undefined,
    trst: trst || undefined,
    rrst: rrst || undefined,
  }), [hisCallsign, myCallsign, trst, rrst]);
  const isActive = cwKeyerStatus?.active ?? false;
  const statusMode = cwKeyerStatus?.mode ?? 'idle';
  const activeSlotId = (statusMode === 'playing' || statusMode === 'repeat-waiting')
    ? cwKeyerStatus?.messageId ?? null
    : null;
  const activeSlotPhase: MacroSlotPhase | null = statusMode === 'playing'
    ? 'transmitting'
    : statusMode === 'repeat-waiting' ? 'waiting' : null;
  const isManualTextPlaying = isActive && statusMode === 'playing' && !cwKeyerStatus?.messageId;

  const macro = useMacroPanel(CW_MESSAGE_PANEL_ADAPTER, myCallsign, { enabled: isCWMode });
  const shortcuts = useSlotShortcuts(cwKeyerShortcutPreferences, myCallsign, macro.panel?.slots);
  const placeholders = useMessagePlaceholders({ values: placeholderValues, i18n: CW_KEYER_I18N });
  const { visibleSlots, updateSlot, updateSlotLocal } = macro;
  const { resolve: resolvePlaceholders, resolveForSend: resolveMessageForSend } = placeholders;

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

  // Trigger sidetone on repeat transitions (repeat-waiting → playing)
  const prevStatusModeRef = useRef(cwKeyerStatus?.mode ?? 'idle');
  useEffect(() => {
    if (!sidetoneEnabled) return;
    const currentMode = cwKeyerStatus?.mode ?? 'idle';
    const prevMode = prevStatusModeRef.current;
    prevStatusModeRef.current = currentMode;

    if (prevMode === 'repeat-waiting' && currentMode === 'playing' && cwKeyerStatus?.messageId) {
      const slot = visibleSlots.find(s => s.id === cwKeyerStatus.messageId);
      if (slot?.text) {
        const resolved = resolvePlaceholders(slot.text);
        if (resolved.text.trim()) {
          sidetoneRef.current?.play(resolved.text.trim());
        }
      }
    }
  }, [cwKeyerStatus?.mode, cwKeyerStatus?.messageId, sidetoneEnabled, visibleSlots, resolvePlaceholders]);

  const clearRealtimeInputQueue = useCallback(() => {
    realtimeInputQueueRef.current = [];
    realtimePendingWordGapRef.current = false;
    realtimeHasQueuedOrSentRef.current = false;
    realtimeBlockedUntilRef.current = 0;
    setRealtimeQueueVersion(value => value + 1);
  }, []);

  const handleStopCW = useCallback(() => {
    clearRealtimeInputQueue();
    stopMessage();
    sidetoneRef.current?.stop();
  }, [clearRealtimeInputQueue, stopMessage]);

  const enqueueRealtimeInput = useCallback((value: string) => {
    let queued = false;
    let displayText = '';

    for (const rawChar of value.toUpperCase()) {
      if (/\s/.test(rawChar)) {
        if (realtimeHasQueuedOrSentRef.current) {
          realtimePendingWordGapRef.current = true;
          displayText += ' ';
        }
        continue;
      }

      if (!REALTIME_CW_CHARACTER_PATTERN.test(rawChar)) {
        continue;
      }

      const gapUnits = !realtimeHasQueuedOrSentRef.current
        ? 0
        : realtimePendingWordGapRef.current ? 7 : 3;
      realtimeInputQueueRef.current.push({ text: rawChar, gapUnits });
      realtimeHasQueuedOrSentRef.current = true;
      realtimePendingWordGapRef.current = false;
      displayText += rawChar;
      queued = true;
    }

    if (displayText) {
      setTextInput(current => current + displayText);
    }

    if (queued) {
      setRealtimeQueueVersion(value => value + 1);
    }
  }, []);

  const handleTextInputModeChange = useCallback((enabled: boolean) => {
    const nextMode: CWTextInputMode = enabled ? 'realtime' : 'buffered';
    setTextInputMode(nextMode);
    clearRealtimeInputQueue();
    setTextInput('');
    try { localStorage.setItem(CW_TEXT_INPUT_MODE_STORAGE_KEY, nextMode); } catch {}
  }, [clearRealtimeInputQueue]);

  const handleSlotHotkey = useCallback((slot: CWMessageSlot) => {
    const resolvedFKey = resolveMessageForSend(slot.text);
    if (!resolvedFKey) return;
    sidetoneRef.current?.play(resolvedFKey);
    playMessage(myCallsign, slot.id, slot.repeatEnabled, true, placeholderValues);
  }, [myCallsign, placeholderValues, playMessage, resolveMessageForSend]);

  useGlobalSlotHotkeys({
    enabled: isCWMode && Boolean(myCallsign) && macro.panelMode === 'operate',
    slots: visibleSlots,
    shortcuts: shortcuts.shortcuts,
    isActive,
    onTrigger: handleSlotHotkey,
    onStop: handleStopCW,
  });

  useEffect(() => {
    if (textInputMode !== 'realtime' || isActive || statusMode !== 'idle' || realtimeInputQueueRef.current.length === 0) {
      return undefined;
    }

    const next = realtimeInputQueueRef.current[0];
    const dotMs = Math.round(1200 / Math.max(WPM_MIN, Math.min(WPM_MAX, Math.round(Number(wpm) || 20))));
    const delayMs = Math.max(0, realtimeBlockedUntilRef.current + (next.gapUnits * dotMs) - Date.now());
    const timer = window.setTimeout(() => {
      if (textInputMode !== 'realtime' || isActive || statusMode !== 'idle') return;
      const pending = realtimeInputQueueRef.current.shift();
      if (!pending) return;
      sidetoneRef.current?.play(pending.text);
      sendText(pending.text, myCallsign || undefined, placeholderValues);
      setLastSentText(pending.text);
      realtimeBlockedUntilRef.current = Date.now() + estimateCWMessageDurationMs(pending.text, wpm);
      setRealtimeQueueVersion(value => value + 1);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [isActive, myCallsign, placeholderValues, realtimeQueueVersion, sendText, statusMode, textInputMode, wpm]);

  useEffect(() => {
    if (textInputMode !== 'realtime') {
      clearRealtimeInputQueue();
    }
  }, [clearRealtimeInputQueue, textInputMode]);

  useEffect(() => () => {
    realtimeInputQueueRef.current = [];
    realtimePendingWordGapRef.current = false;
    realtimeHasQueuedOrSentRef.current = false;
    realtimeBlockedUntilRef.current = 0;
  }, []);

  const handleSendText = useCallback((text = textInput) => {
    const trimmed = text.trim();
    if (!trimmed || (isActive && statusMode !== 'idle')) return;
    clearRealtimeInputQueue();
    const resolvedText = resolveMessageForSend(trimmed);
    if (!resolvedText) return;
    sidetoneRef.current?.play(resolvedText);
    sendText(trimmed, myCallsign || undefined, placeholderValues);
    setLastSentText(resolvedText);
    if (text === textInput) {
      setTextInput('');
      requestAnimationFrame(() => {
        textInputRef.current?.focus();
      });
    }
  }, [clearRealtimeInputQueue, isActive, myCallsign, placeholderValues, resolveMessageForSend, sendText, statusMode, textInput]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (textInputMode === 'realtime') {
      if (e.key === 'Enter') {
        e.preventDefault();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const input = textInputRef.current;
        setTextInput(current => {
          const selectionStart = input?.selectionStart ?? current.length;
          const selectionEnd = input?.selectionEnd ?? current.length;
          if (selectionStart !== selectionEnd) {
            return current.slice(0, selectionStart) + current.slice(selectionEnd);
          }
          if (e.key === 'Delete') {
            return current.slice(0, selectionStart) + current.slice(selectionStart + 1);
          }
          return current.slice(0, Math.max(0, selectionStart - 1)) + current.slice(selectionStart);
        });
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing || e.key.length !== 1) {
        return;
      }
      e.preventDefault();
      enqueueRealtimeInput(e.key);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isActive && statusMode !== 'idle') return;
      handleSendText();
    }
  };

  const handleTextInputPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (textInputMode !== 'realtime') return;
    e.preventDefault();
    enqueueRealtimeInput(e.clipboardData.getData('text'));
  };

  const handleWpmChange = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    setWpm(v);
  };

  const handleWpmChangeEnd = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    void api.updateCWKeyerConfig({ wpm: v }).then((resp) => setLoadedConfig(resp.config));
  };

  const handleSidetoneEnabledChange = (enabled: boolean) => {
    setSidetoneEnabled(enabled);
    try { localStorage.setItem('tx5dr_cw_sidetone_enabled', String(enabled)); } catch {}
    if (!enabled) {
      sidetoneRef.current?.stop();
    }
  };

  const handleSidetoneFrequencyChange = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : Math.round(value);
    setSidetoneFrequency(v);
    try { localStorage.setItem('tx5dr_cw_sidetone_frequency', String(v)); } catch {}
  };

  const handleSidetoneVolumeChange = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    setSidetoneVolume(v);
    try { localStorage.setItem('tx5dr_cw_sidetone_volume', String(v)); } catch {}
  };

  const handleBackendChange = (key: React.Key) => {
    clearRealtimeInputQueue();
    const nextBackend: CWKeyerBackend = key === 'serial' ? 'serial' : 'cat';
    setLoadedConfig((prev) => ({
      backend: nextBackend,
      keyPort: prev?.keyPort ?? effectiveConfig?.keyPort ?? '',
      keyMethod: prev?.keyMethod ?? effectiveConfig?.keyMethod ?? 'dtr',
      keyActiveLevel: prev?.keyActiveLevel ?? effectiveConfig?.keyActiveLevel ?? 'high',
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

  const handlePlay = (slot: CWMessageSlot) => {
    if (!myCallsign || !slot.text) return;
    if (activeSlotId === slot.id) {
      handleStopCW();
      return;
    }
    if (isActive) return;
    const resolvedText = resolveMessageForSend(slot.text);
    if (!resolvedText) return;
    sidetoneRef.current?.play(resolvedText);
    playMessage(myCallsign, slot.id, slot.repeatEnabled, true, placeholderValues);
  };

  const handleRepeatToggle = async (slot: CWMessageSlot) => {
    const repeatEnabled = !slot.repeatEnabled;
    const resolvedRepeatText = slot.text ? resolveMessageForSend(slot.text) : null;
    if (repeatEnabled && slot.text && !resolvedRepeatText) {
      return;
    }
    updateSlotLocal(slot.id, { repeatEnabled });
    const updatedPanel = await updateSlot(slot.id, { repeatEnabled });
    if (!updatedPanel) {
      updateSlotLocal(slot.id, { repeatEnabled: slot.repeatEnabled });
      return;
    }
    if (repeatEnabled && resolvedRepeatText && !isActive) {
      sidetoneRef.current?.play(resolvedRepeatText);
      playMessage(myCallsign, slot.id, true, false, placeholderValues);
    } else if (!repeatEnabled && activeSlotId === slot.id) {
      handleStopCW();
    }
  };

  if (!isCWMode) return null;

  const lastSentDurationMs = estimateCWMessageDurationMs(lastSentText ?? '', wpm);

  return (
    <>
      <KeyboardMacroPanel
        embedded={embedded}
        i18n={CW_KEYER_I18N}
        icon={faWaveSquare}
        statusChip={isActive && (
          <Chip size="sm" variant="flat" color={statusMode === 'repeat-waiting' ? 'warning' : 'success'} className="h-5 text-[10px]">
            {statusMode === 'keying' ? 'KEYING' : statusMode === 'playing' ? 'TX' : statusMode}
          </Chip>
        )}
        settingsContent={(
          <div className="flex w-full flex-col gap-3">
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
            <div className="flex items-center justify-between gap-3 border-t border-default-200 pt-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-default-700">{t('radio:cw.textInputModeRealtime', 'Realtime typing')}</div>
                <div className="mt-0.5 text-[11px] leading-4 text-default-500">
                  {t('radio:cw.textInputModeDescription', 'Buffered mode sends with Enter; realtime mode queues each typed character immediately.')}
                </div>
              </div>
              <Switch
                size="sm"
                isSelected={textInputMode === 'realtime'}
                onValueChange={handleTextInputModeChange}
                aria-label={t('radio:cw.textInputModeRealtime', 'Realtime typing')}
              />
            </div>
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
            <div className="border-t border-default-200 pt-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-default-700">{t('radio:cw.sidetone', 'Sidetone')}</span>
                <Button
                  size="sm"
                  variant={sidetoneEnabled ? 'solid' : 'flat'}
                  color={sidetoneEnabled ? 'primary' : 'default'}
                  onPress={() => handleSidetoneEnabledChange(!sidetoneEnabled)}
                  className="h-6 min-w-0 rounded-full px-3 text-[10px]"
                >
                  {sidetoneEnabled ? 'ON' : 'OFF'}
                </Button>
              </div>
              {sidetoneEnabled && (
                <>
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className="w-20 shrink-0 text-xs text-default-500">{t('radio:cw.sidetoneFrequency', 'Pitch')}</span>
                    <Slider
                      size="sm"
                      step={10}
                      minValue={300}
                      maxValue={1200}
                      value={sidetoneFrequency}
                      onChange={handleSidetoneFrequencyChange}
                      className="flex-1"
                      aria-label={t('radio:cw.sidetoneFrequency', 'Sidetone pitch')}
                    />
                    <span className="w-12 text-right font-mono text-xs text-default-800">{sidetoneFrequency}Hz</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-xs text-default-500">{t('radio:cw.sidetoneVolume', 'Volume')}</span>
                    <Slider
                      size="sm"
                      step={0.05}
                      minValue={0.05}
                      maxValue={1}
                      value={sidetoneVolume}
                      onChange={handleSidetoneVolumeChange}
                      className="flex-1"
                      aria-label={t('radio:cw.sidetoneVolume', 'Sidetone volume')}
                    />
                    <span className="w-12 text-right font-mono text-xs text-default-800">{Math.round(sidetoneVolume * 100)}%</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        alerts={(
          <>
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
                  {catUnavailableReason || t('radio:cw.catUnavailableBody', 'Connect a radio that supports CAT/radio CW text sending before using this backend.')}
                </span>
              </Alert>
            )}
          </>
        )}
        inputArea={(
          <>
            <div className="flex gap-2">
              <Input
                ref={textInputRef}
                value={textInput}
                onValueChange={(value) => {
                  if (textInputMode === 'buffered') {
                    setTextInput(value.toUpperCase());
                  }
                }}
                onKeyDown={handleKeyDown}
                onPaste={handleTextInputPaste}
                placeholder={textInputMode === 'realtime'
                  ? t('radio:cw.realtimeTextInputPlaceholder', 'Realtime typing: typed characters are queued for CW immediately')
                  : t('radio:cw.textInputPlaceholder', 'Enter CW text...')}
                className="flex-1"
                endContent={textInputMode === 'buffered' ? (
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
                ) : null}
              />
            </div>

            {textInputMode === 'buffered' && lastSentText && (
              <div className={`rounded-lg p-2 transition-colors ${isManualTextPlaying ? 'bg-danger-50 dark:bg-danger-950/20' : 'bg-content2'}`}>
                <Button
                  color={isManualTextPlaying ? 'danger' : 'default'}
                  variant={isManualTextPlaying ? 'solid' : 'flat'}
                  className={`relative h-12 w-full overflow-hidden rounded-md px-2 transition-colors ${isManualTextPlaying ? '' : 'hover:bg-primary-50 dark:hover:bg-primary-500/10'}`}
                  onPress={() => isManualTextPlaying ? handleStopCW() : handleSendText(lastSentText)}
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
          </>
        )}
        macro={macro}
        shortcuts={shortcuts}
        placeholders={placeholders}
        isBusy={isActive}
        activeSlotId={activeSlotId}
        activeSlotPhase={activeSlotPhase}
        onPlaySlot={handlePlay}
        repeat={{
          onToggle: (slot) => void handleRepeatToggle(slot),
          onIntervalChange: macro.setRepeatIntervalSec,
          nextRunAt: cwKeyerStatus?.nextRunAt ?? null,
        }}
        getSlotDurationMs={(text) => estimateCWMessageDurationMs(text, wpm)}
      />
      <CWSidetone ref={sidetoneRef} wpm={wpm} frequency={sidetoneFrequency} enabled={sidetoneEnabled} volume={sidetoneVolume} />
    </>
  );
}
