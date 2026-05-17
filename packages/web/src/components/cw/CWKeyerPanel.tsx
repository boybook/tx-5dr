import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Alert,
  Input,
  Slider,
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
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faStop,
  faPen,
  faEraser,
  faPaperPlane,
  faRepeat,
  faClock,
  faWaveSquare,
  faTowerBroadcast,
  faPlug,
  faGear,
  faPlus,
  faMinus,
  faGripVertical,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import {
  estimateCWMessageDurationMs,
  type CWKeyerBackend,
  type CWKeyerConfig,
  type CWMessagePanel,
  type CWMessageSlot,
  type CWPlaceholderValues,
} from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { useCWKeyer } from '../../hooks/useCWKeyer';
import { useOperators, useCurrentOperatorId, useRadioState } from '../../store/radioStore';
import { CWSidetone, type CWSidetoneHandle } from './CWSidetone';
import {
  getCWKeyerShortcutPresetsForCallsign,
  saveCWKeyerSlotShortcutPreset,
  matchesCWKeyerShortcut,
  CW_KEYER_SHORTCUT_PRESETS,
  CW_KEYER_SHORTCUT_NONE,
  CW_KEYER_SHORTCUT_CHANGED_EVENT,
} from '../../utils/cwKeyerShortcutPreferences';
import type { CWKeyerShortcutPreset, CWKeyerShortcutChangedDetail } from '../../utils/cwKeyerShortcutPreferences';
import { useCWQSODraft } from '../../store/cwQsoDraftStore';
import {
  resolveCWMessagePlaceholders,
  type CWMessageSegment,
  type CWPlaceholderName,
} from '../../utils/cwMessagePlaceholders';

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
  const { hisCallsign, trst, rrst } = useCWQSODraft();

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
  const [dragSlotId, setDragSlotId] = useState<string | null>(null);
  const [dragOverSlotId, setDragOverSlotId] = useState<string | null>(null);
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
  const radioConnected = radioState.state.radioConnected;
  const radioConfigType = radioState.state.radioConfig?.type;
  const isRadioKeyerCapableConfig = radioConfigType === 'serial'
    || radioConfigType === 'network'
    || radioConfigType === 'icom-wlan';
  const catBackendError = cwKeyerStatus?.backend === 'cat' && cwKeyerStatus.backendAvailable === false
    ? cwKeyerStatus.backendError
    : null;
  const catUnsupportedSendMorse = catBackendError?.includes('SEND_MORSE') === true
    || catBackendError?.includes('CW 0x17') === true
    || catBackendError?.includes('CW text sending support') === true;
  const catUnavailableReason = !radioConnected
    ? t('radio:cw.catUnavailableDisconnected', 'Connect a radio before using CAT CW.')
    : !isRadioKeyerCapableConfig
      ? t('radio:cw.catUnavailableHamlibOnly', 'CAT CW currently supports Hamlib serial/network or ICOM WLAN radio connections only.')
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

  const visibleSlots = useMemo(() => panel?.slots.slice(0, panel.slotCount) ?? [], [panel]);

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
        const resolved = resolveCWMessagePlaceholders(slot.text, placeholderValues);
        if (resolved.text.trim()) {
          sidetoneRef.current?.play(resolved.text.trim());
        }
      }
    }
  }, [cwKeyerStatus?.mode, cwKeyerStatus?.messageId, sidetoneEnabled, visibleSlots, placeholderValues]);

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
  const canIncreaseSlots = (panel?.slotCount ?? 0) < (panel?.maxSlotCount ?? 12);
  const canDecreaseSlots = (panel?.slotCount ?? 3) > 3;

  const getPlaceholderLabel = useCallback((placeholder: CWPlaceholderName): string => {
    switch (placeholder) {
      case 'MYCALL':
        return t('radio:cw.placeholderMyCall', 'Current operator callsign');
      case 'HISCALL':
        return t('radio:cw.placeholderHisCall', 'QSO log station callsign');
      case 'TRST':
        return t('radio:cw.placeholderTrst', 'Sent signal report');
      case 'RRST':
        return t('radio:cw.placeholderRrst', 'Received signal report');
      default:
        return '';
    }
  }, [t]);

  const getPlaceholderMissingLabel = useCallback((placeholder: CWPlaceholderName): string => {
    switch (placeholder) {
      case 'MYCALL':
        return t('radio:cw.placeholderMissingMyCall', 'Operator callsign');
      case 'HISCALL':
        return t('radio:cw.placeholderMissingHisCall', 'Station callsign');
      case 'TRST':
        return t('radio:cw.placeholderMissingTrst', 'Sent RST');
      case 'RRST':
        return t('radio:cw.placeholderMissingRrst', 'Received RST');
      default:
        return '';
    }
  }, [t]);

  const getMissingPlaceholderText = useCallback((placeholders: CWPlaceholderName[]): string => {
    const labels = placeholders.map(getPlaceholderLabel).join(', ');
    return t('radio:cw.placeholderMissingToast', 'Fill in {{placeholders}} before sending this CW message.', { placeholders: labels });
  }, [getPlaceholderLabel, t]);

  const resolveMessageForSend = useCallback((text: string): string | null => {
    const resolved = resolveCWMessagePlaceholders(text, placeholderValues);
    if (resolved.unresolved.length > 0) {
      addToast({
        title: t('radio:cw.placeholderMissingTitle', 'Missing CW placeholder value'),
        description: getMissingPlaceholderText(resolved.unresolved),
        color: 'warning',
      });
      return null;
    }
    const trimmed = resolved.text.trim();
    return trimmed || null;
  }, [getMissingPlaceholderText, placeholderValues, t]);

  const renderMessageSegments = useCallback((segments: CWMessageSegment[]) => (
    segments.map((segment, index) => {
      if (segment.type === 'text') {
        return <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>;
      }

      const content = segment.resolved
        ? segment.text
        : getPlaceholderMissingLabel(segment.placeholder);
      const tooltip = segment.resolved
        ? t('radio:cw.placeholderTooltip', '{{source}}: {{label}}', {
            source: segment.source.toUpperCase(),
            label: getPlaceholderLabel(segment.placeholder),
          })
        : t('radio:cw.placeholderMissingTooltip', '{{source}} needs {{label}}', {
            source: segment.source.toUpperCase(),
            label: getPlaceholderLabel(segment.placeholder),
          });

      return (
        <Tooltip key={`${segment.source}-${index}`} content={tooltip} delay={250}>
          <span
            className={`mx-0.5 inline-flex h-6 items-center rounded-md border px-1.5 font-mono text-xs font-bold leading-none align-middle ${
              segment.resolved
                ? 'border-emerald-300 bg-emerald-200 text-emerald-950 dark:border-emerald-300/70 dark:bg-emerald-300 dark:text-emerald-950'
                : 'border-amber-300 bg-amber-200 text-amber-950 dark:border-amber-300/70 dark:bg-amber-300 dark:text-amber-950'
            }`}
          >
            {content}
          </span>
        </Tooltip>
      );
    })
  ), [getPlaceholderLabel, getPlaceholderMissingLabel, t]);

  const renderPlaceholderHint = useCallback(() => (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-content2 px-2 py-1.5 text-[11px] text-default-500">
      <span>{t('radio:cw.placeholderHint', 'Placeholders')}</span>
      {(['MYCALL', 'HISCALL', 'TRST', 'RRST'] as CWPlaceholderName[]).map((placeholder) => (
        <Tooltip
          key={placeholder}
          content={getPlaceholderLabel(placeholder)}
          delay={250}
        >
          <Chip
            size="sm"
            variant="flat"
            color={placeholder === 'MYCALL' ? 'primary' : placeholder === 'HISCALL' ? 'warning' : 'secondary'}
            className="h-5 px-1 font-mono text-[10px] font-semibold"
          >
            {`{${placeholder}}`}
          </Chip>
        </Tooltip>
      ))}
      <span>{t('radio:cw.placeholderHintSuffix', 'are replaced when sending.')}</span>
    </div>
  ), [getPlaceholderLabel, t]);

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
      const isFKey = /^F(?:[1-9]|1[0-2])$/.test(event.code);
      if (isTypingTarget(event.target) && !isFKey && event.key !== 'Escape') return;

      if (event.key === 'Escape' && isActive) {
        event.preventDefault();
        stopMessage();
        sidetoneRef.current?.stop();
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
      const resolvedFKey = resolveMessageForSend(slot.text);
      if (!resolvedFKey) return;
      sidetoneRef.current?.play(resolvedFKey);
      playMessage(myCallsign, slot.id, slot.repeatEnabled, true, placeholderValues);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
  }, [isActive, isCWMode, myCallsign, panelMode, placeholderValues, playMessage, resolveMessageForSend, slotShortcuts, stopMessage, visibleSlots]);

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
    const resolvedText = resolveMessageForSend(trimmed);
    if (!resolvedText) return;
    sidetoneRef.current?.play(resolvedText);
    sendText(trimmed, myCallsign || undefined, placeholderValues);
    setLastSentText(resolvedText);
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
  }, [isActive, myCallsign, placeholderValues, resolveMessageForSend, sendText, statusMode, textInput]);

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

  const handleDrop = useCallback(async (e: React.DragEvent, targetSlotId: string) => {
    e.preventDefault();
    setDragOverSlotId(null);
    const sourceSlotId = dragSlotId;
    if (!sourceSlotId || sourceSlotId === targetSlotId || !myCallsign) return;

    // Optimistic local swap
    setPanel(current => {
      if (!current) return current;
      const sourceSlot = current.slots.find(s => s.id === sourceSlotId);
      const targetSlot = current.slots.find(s => s.id === targetSlotId);
      if (!sourceSlot || !targetSlot) return current;
      const swapFields = ['label', 'text', 'repeatEnabled', 'repeatIntervalSec'] as const;
      return {
        ...current,
        slots: current.slots.map(slot => {
          if (slot.id === sourceSlotId) {
            const merged = { ...slot };
            for (const f of swapFields) merged[f] = targetSlot[f] as never;
            return merged;
          }
          if (slot.id === targetSlotId) {
            const merged = { ...slot };
            for (const f of swapFields) merged[f] = sourceSlot[f] as never;
            return merged;
          }
          return slot;
        }),
      };
    });

    // Swap F-key shortcuts
    const shortcutA = slotShortcuts[sourceSlotId] ?? CW_KEYER_SHORTCUT_NONE;
    const shortcutB = slotShortcuts[targetSlotId] ?? CW_KEYER_SHORTCUT_NONE;
    setSlotShortcuts(prev => ({
      ...prev,
      [sourceSlotId]: shortcutB,
      [targetSlotId]: shortcutA,
    }));
    saveCWKeyerSlotShortcutPreset(myCallsign, sourceSlotId, shortcutB);
    saveCWKeyerSlotShortcutPreset(myCallsign, targetSlotId, shortcutA);

    // Persist to server
    try {
      const resp = await api.swapCWMessageSlots(myCallsign, sourceSlotId, targetSlotId);
      setPanel(resp.panel);
    } catch (err) {
      addToast({
        title: t('common:error'),
        description: String(err),
        color: 'danger',
      });
      void loadPanel();
    }
  }, [dragSlotId, myCallsign, slotShortcuts, t, loadPanel]);

  const handlePlay = (slot: CWMessageSlot) => {
    if (!myCallsign || !slot.text) return;
    if (activeSlotId === slot.id) {
      stopMessage();
      sidetoneRef.current?.stop();
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
      stopMessage();
      sidetoneRef.current?.stop();
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
      <div className={`flex items-center justify-between gap-2 ${embedded ? 'pb-3' : 'px-3 py-4'}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FontAwesomeIcon icon={faWaveSquare} />
          </span>
          <span className="truncate text-sm font-semibold text-foreground">{t('radio:cw.keyerTitle', 'CW Keyer')}</span>
          {isActive && (
            <Chip size="sm" variant="flat" color={statusMode === 'repeat-waiting' ? 'warning' : 'success'} className="h-5 text-[10px]">
              {statusMode === 'keying' ? 'KEYING' : statusMode === 'playing' ? 'TX' : statusMode}
            </Chip>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Popover placement="bottom-end">
            <PopoverTrigger>
              <Button
                isIconOnly
                size="sm"
                variant="flat"
                aria-label={t('radio:cw.settings', 'Settings')}
                className="h-7 min-w-7 rounded-md"
              >
                <FontAwesomeIcon icon={faGear} className="text-xs" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 gap-3 p-3">
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
            </PopoverContent>
          </Popover>
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

      <CWSidetone ref={sidetoneRef} wpm={wpm} frequency={sidetoneFrequency} enabled={sidetoneEnabled} volume={sidetoneVolume} />

      <div className={`flex flex-col gap-3 ${embedded ? 'flex-1 min-h-0 overflow-hidden' : 'px-3 pb-3'}`}>
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

        <div className="flex gap-2">
          <Input
            ref={textInputRef}
            value={textInput}
            onValueChange={(value) => setTextInput(value.toUpperCase())}
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

        <div className={embedded ? 'flex flex-1 min-h-0 flex-col' : undefined}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-default-600">
              {t('radio:cw.presetMessages', 'Presets')}
            </span>
            {panelMode === 'edit' && (
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
            )}
          </div>

          {panelMode === 'edit' && renderPlaceholderHint()}

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
                <div className="flex w-full flex-col gap-1.5">
                  {visibleSlots.map((slot) => {
                    const active = activeSlotId === slot.id;
                    const transmitting = active && statusMode === 'playing';
                    const waiting = active && statusMode === 'repeat-waiting';
                    const intervalValue = Math.max(1, Math.min(300, Math.round(Number(slot.repeatIntervalSec) || 1)));
                    const remainingSeconds = waiting ? getRemainingSeconds(cwKeyerStatus?.nextRunAt ?? null, intervalValue) : null;
                    const resolvedSlot = resolveCWMessagePlaceholders(slot.text, placeholderValues);
                    const durationMs = estimateCWMessageDurationMs(resolvedSlot.text, wpm);
                    const shortcutPreset = slotShortcuts[slot.id] ?? CW_KEYER_SHORTCUT_NONE;
                    const activeToneClass = waiting
                      ? 'bg-warning-50 dark:bg-warning-950/20'
                      : active
                        ? 'bg-danger-50 dark:bg-danger-950/20'
                        : 'bg-content2';

                    return (
                      <div key={slot.id} className={`flex items-center gap-1.5 rounded-lg p-1.5 transition-colors ${activeToneClass}`}>
                        <Button
                          color={transmitting ? 'danger' : active ? 'warning' : 'primary'}
                          variant={transmitting ? 'solid' : active ? 'flat' : 'solid'}
                          className="relative h-9 min-w-0 flex-1 overflow-hidden rounded-md px-2"
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
                                ? renderMessageSegments(resolvedSlot.segments)
                                : t('radio:cw.emptySlotHint', 'Edit this slot first')}
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
                        <Button
                          isIconOnly
                          size="sm"
                          color={slot.repeatEnabled ? 'warning' : 'default'}
                          variant={slot.repeatEnabled ? 'solid' : 'flat'}
                          aria-label={t('radio:cw.repeatToggle', 'Repeat toggle')}
                          onPress={() => void handleRepeatToggle(slot)}
                          isDisabled={!slot.text || (isActive && !active)}
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
                          aria-label={t('radio:cw.repeatInterval', 'Interval (s)')}
                          endContent={<span className="text-[11px] text-default-400">s</span>}
                          className="w-16 shrink-0"
                          classNames={{ inputWrapper: 'h-8 min-h-8 px-2', input: 'text-xs font-mono' }}
                          onValueChange={(value) => handleRepeatIntervalChange(slot, value)}
                          isDisabled={!slot.text || (isActive && !active)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex w-full flex-col gap-1.5">
                  {visibleSlots.map((slot) => {
                    const shortcutPreset = slotShortcuts[slot.id] ?? CW_KEYER_SHORTCUT_NONE;

                    const isDragging = dragSlotId === slot.id;
                    const isDragOver = dragOverSlotId === slot.id && dragSlotId !== slot.id;

                    return (
                      <div
                        key={slot.id}
                        draggable={!isActive}
                        onDragStart={(e) => handleDragStart(e, slot.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleDragOver(e, slot.id)}
                        onDragLeave={(e) => handleDragLeave(e, slot.id)}
                        onDrop={(e) => handleDrop(e, slot.id)}
                        className={`flex items-center gap-1.5 rounded-lg p-1.5 transition-all duration-200 ${
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
                          aria-label={t('radio:cw.shortcutSelectAria', { slot: slot.index })}
                          selectedKeys={[shortcutPreset]}
                          onSelectionChange={(keys) => {
                            const selected = Array.from(keys)[0] as CWKeyerShortcutPreset | undefined;
                            if (selected) updateSlotShortcut(slot, selected);
                          }}
                          className="w-20 shrink-0"
                          classNames={{
                            trigger: 'h-8 min-h-8 rounded-full px-2 bg-default-100',
                            value: 'font-mono text-[10px] font-semibold',
                          }}
                          isDisabled={isActive}
                        >
                          {CW_KEYER_SHORTCUT_PRESETS.map((preset) => (
                            <SelectItem key={preset} textValue={getShortcutLabel(preset)}>
                              {getShortcutLabel(preset)}
                            </SelectItem>
                          ))}
                        </Select>
                        <Input
                          size="sm"
                          variant="flat"
                          value={slot.text}
                          aria-label={t('radio:cw.messageText', 'Text')}
                          maxLength={500}
                          className="min-w-0 flex-1"
                          classNames={{ input: 'font-mono text-xs font-semibold', inputWrapper: 'h-8 min-h-8 px-2' }}
                          placeholder={t('radio:cw.messageTextPlaceholder', 'CQ CQ CQ DE {{callsign}}', { callsign: myCallsign })}
                          onValueChange={(value) => updateSlotLocal(slot.id, { text: value })}
                          onBlur={(event) => void updateSlot(slot.id, { text: event.currentTarget.value })}
                          isDisabled={isActive}
                        />
                        <Input
                          size="sm"
                          variant="flat"
                          value={slot.label}
                          aria-label={t('radio:cw.messageLabel', 'Label')}
                          maxLength={32}
                          className="w-28 shrink-0"
                          classNames={{ input: 'text-xs font-medium text-right', inputWrapper: 'h-8 min-h-8 pl-2 pr-4' }}
                          onValueChange={(value) => updateSlotLocal(slot.id, { label: value })}
                          onBlur={(event) => void updateSlot(slot.id, { label: event.currentTarget.value })}
                          isDisabled={isActive}
                        />
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          color="danger"
                          aria-label={t('radio:cw.clearSlot', 'Clear')}
                          onPress={() => void handleDeleteSlot(slot)}
                          isDisabled={!slot.text || isActive}
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
      <div className="h-full min-h-0 w-full overflow-hidden rounded-xl bg-content1/80 p-3 shadow-sm ring-1 ring-default-200/60">
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
