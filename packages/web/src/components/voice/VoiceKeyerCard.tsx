import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Select,
  SelectItem,
  Spinner,
  Tab,
  Tabs,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronRight,
  faClock,
  faCircle,
  faPen,
  faPause,
  faPlay,
  faRepeat,
  faStop,
  faTowerBroadcast,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import type { VoiceKeyerPanel, VoiceKeyerSlot, VoiceKeyerStatus } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import { useConnection, useCurrentOperatorId, useOperators } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { useWSEvent } from '../../hooks/useWSEvent';
import { createLogger } from '../../utils/logger';
import {
  type VoiceKeyerShortcutPreset,
  VOICE_KEYER_SHORTCUT_CHANGED_EVENT,
  VOICE_KEYER_SHORTCUT_NONE,
  VOICE_KEYER_SHORTCUT_PRESETS,
  getVoiceKeyerShortcutPresetsForCallsign,
  matchesVoiceKeyerShortcut,
  normalizeVoiceKeyerShortcutPreset,
  saveVoiceKeyerSlotShortcutPreset,
} from '../../utils/voiceKeyerShortcutPreferences';

const logger = createLogger('VoiceKeyerCard');
const TARGET_SAMPLE_RATE = 16000;
const MAX_RECORDING_MS = 120_000;
const TX_PROGRESS_OVERHEAD_MS = 650;
type KeyerPanelMode = 'operate' | 'edit';

function ShortcutChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`h-3 w-3 text-default-500 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

interface RecorderSession {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  startedAt: number;
  sampleRate: number;
  timer: number;
  slotId: string;
}

const idleStatus: VoiceKeyerStatus = {
  active: false,
  callsign: null,
  slotId: null,
  mode: 'idle',
  repeating: false,
  startedBy: null,
  startedByLabel: null,
  nextRunAt: null,
  error: null,
};

function normalizeCallsign(callsign: string | undefined): string {
  return (callsign || '').trim().toUpperCase();
}

function formatDuration(durationMs: number): string {
  if (!durationMs) return '--';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
}

function formatRecordingElapsed(durationMs: number): string {
  const safeDuration = Math.max(0, Math.floor(durationMs));
  const minutes = Math.floor(safeDuration / 60000);
  const seconds = Math.floor((safeDuration % 60000) / 1000);
  const centiseconds = Math.floor((safeDuration % 1000) / 10);
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
}

function calculateInputLevel(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    sum += clamped * clamped;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(0, Math.min(1, rms * 5));
}

function getTxProgressStyle(durationMs: number): React.CSSProperties {
  return {
    animation: `voice-keyer-tx-progress ${Math.max(800, durationMs + TX_PROGRESS_OVERHEAD_MS)}ms linear forwards`,
  };
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

function encodePcm16Wav(samples: Float32Array, sampleRate: number): Blob {
  const headerBytes = 44;
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = headerBytes;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export const VoiceKeyerCard: React.FC = () => {
  const { t } = useTranslation('voice');
  const connection = useConnection();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();
  const isOperator = useHasMinRole(UserRole.OPERATOR);
  const radioService = connection.state.radioService;

  const [isCollapsed, setIsCollapsed] = useState(true);
  const [panel, setPanel] = useState<VoiceKeyerPanel | null>(null);
  const [status, setStatus] = useState<VoiceKeyerStatus>(idleStatus);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [selectedOperatorId, setSelectedOperatorId] = useState<string | null>(currentOperatorId);
  const [recordingSlotId, setRecordingSlotId] = useState<string | null>(null);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [recordingInputLevel, setRecordingInputLevel] = useState(0);
  const [busySlotId, setBusySlotId] = useState<string | null>(null);
  const [previewLoadingSlotId, setPreviewLoadingSlotId] = useState<string | null>(null);
  const [previewPlayingSlotId, setPreviewPlayingSlotId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<KeyerPanelMode>('operate');
  const [txProgressRunId, setTxProgressRunId] = useState(0);
  const [slotShortcuts, setSlotShortcuts] = useState<Record<string, VoiceKeyerShortcutPreset>>({});
  const [shortcutMenuSlotId, setShortcutMenuSlotId] = useState<string | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const slotUpdateTimersRef = useRef<Record<string, number>>({});
  const lastMeterUpdateRef = useRef(0);

  const selectedOperator = operators.find(op => op.id === selectedOperatorId) || null;
  const callsign = normalizeCallsign(selectedOperator?.context?.myCall);
  const visibleSlots = useMemo(() => (panel?.slots ?? []).slice(0, panel?.slotCount ?? 0), [panel]);
  const hasCallsign = Boolean(callsign);
  const canOperate = isOperator && hasCallsign && connection.state.isConnected;
  const activeForCallsign = status.active && status.callsign === callsign;
  const activeSlot = activeForCallsign ? status.slotId : null;

  useEffect(() => {
    setSelectedOperatorId(currentOperatorId);
  }, [currentOperatorId]);

  useWSEvent(radioService, 'voiceKeyerStatusChanged', (nextStatus: VoiceKeyerStatus) => {
    setStatus(nextStatus);
  });

  useEffect(() => {
    if (!(status.active && status.mode === 'repeat-waiting')) {
      return undefined;
    }
    const timer = window.setInterval(() => setTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status.active, status.mode]);

  useEffect(() => {
    if (status.active && status.mode === 'playing' && status.slotId) {
      setTxProgressRunId(value => value + 1);
    }
  }, [status.active, status.mode, status.slotId]);

  useEffect(() => {
    setShortcutMenuSlotId(null);
    setSlotShortcuts(getVoiceKeyerShortcutPresetsForCallsign(callsign, panel?.slots ?? []));
  }, [callsign, panel?.slots]);

  useEffect(() => {
    const handleShortcutChange = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        callsign?: string;
        slotId?: string;
        preset?: unknown;
      };
      if (!detail?.slotId || normalizeCallsign(detail.callsign) !== callsign) return;
      const slot = panel?.slots.find(candidate => candidate.id === detail.slotId);
      if (!slot) return;

      setSlotShortcuts(current => ({
        ...current,
        [slot.id]: normalizeVoiceKeyerShortcutPreset(detail.preset, current[slot.id] ?? VOICE_KEYER_SHORTCUT_NONE),
      }));
      setShortcutMenuSlotId(null);
    };

    window.addEventListener(VOICE_KEYER_SHORTCUT_CHANGED_EVENT, handleShortcutChange);
    return () => {
      window.removeEventListener(VOICE_KEYER_SHORTCUT_CHANGED_EVENT, handleShortcutChange);
    };
  }, [callsign, panel?.slots]);

  useEffect(() => {
    if (!recordingSlotId) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      const session = recorderRef.current;
      setRecordingElapsedMs(session ? Date.now() - session.startedAt : 0);
    }, 33);
    return () => window.clearInterval(timer);
  }, [recordingSlotId]);

  const loadPanel = useCallback(async () => {
    if (!callsign || !connection.state.isConnected || !isOperator) {
      setPanel(null);
      return;
    }

    setLoading(true);
    try {
      const response = await api.getVoiceKeyerPanel(callsign);
      setPanel(response.panel);
    } catch (error) {
      logger.error('Failed to load voice keyer panel', error);
      addToast({ title: t('keyer.loadFailed'), color: 'danger', timeout: 4000 });
    } finally {
      setLoading(false);
    }
  }, [callsign, connection.state.isConnected, isOperator, t]);

  useEffect(() => {
    void loadPanel();
  }, [loadPanel]);

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = '';
      previewAudioRef.current = null;
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewLoadingSlotId(null);
    setPreviewPlayingSlotId(null);
  }, []);

  const stopRecorder = useCallback(async (upload: boolean) => {
    const session = recorderRef.current;
    if (!session) return;

    recorderRef.current = null;
    setRecordingSlotId(null);
    setRecordingElapsedMs(0);
    setRecordingInputLevel(0);
    window.clearTimeout(session.timer);
    try {
      session.processor.disconnect();
      session.source.disconnect();
    } catch {
      // ignore
    }
    session.stream.getTracks().forEach(track => track.stop());
    await session.audioContext.close().catch(() => undefined);

    if (!upload || !callsign) return;

    const source = mergeChunks(session.chunks);
    const durationMs = Date.now() - session.startedAt;
    if (durationMs < 500 || source.length === 0) {
      addToast({ title: t('keyer.recordTooShort'), color: 'warning', timeout: 3000 });
      return;
    }

    setBusySlotId(session.slotId);
    try {
      const resampled = resampleLinear(source, session.sampleRate, TARGET_SAMPLE_RATE);
      const wav = encodePcm16Wav(resampled, TARGET_SAMPLE_RATE);
      const response = await api.uploadVoiceKeyerSlot(callsign, session.slotId, wav);
      setPanel(response.panel);
      addToast({ title: t('keyer.recordSaved'), color: 'success', timeout: 2500 });
    } catch (error) {
      logger.error('Failed to upload voice keyer recording', error);
      addToast({ title: t('keyer.recordFailed'), color: 'danger', timeout: 5000 });
    } finally {
      setBusySlotId(null);
    }
  }, [callsign, t]);

  const startRecording = useCallback(async (slotId: string) => {
    if (!canOperate || recordingSlotId) return;
    stopPreview();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('AudioContext is not available');
      }
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
        const now = performance.now();
        if (now - lastMeterUpdateRef.current > 50) {
          lastMeterUpdateRef.current = now;
          setRecordingInputLevel(calculateInputLevel(input));
        }
        event.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      const timer = window.setTimeout(() => {
        void stopRecorder(true);
      }, MAX_RECORDING_MS);
      recorderRef.current = { stream, audioContext, source, processor, chunks, startedAt: Date.now(), sampleRate: audioContext.sampleRate, timer, slotId };
      setRecordingElapsedMs(0);
      setRecordingInputLevel(0);
      lastMeterUpdateRef.current = performance.now();
      setRecordingSlotId(slotId);
    } catch (error) {
      logger.error('Failed to start voice keyer recording', error);
      addToast({
        title: t('keyer.micFailed'),
        description: window.isSecureContext
          ? t('keyer.micFailedDescription')
          : t('keyer.micFailedHttpsDescription', { origin: window.location.origin }),
        color: 'danger',
        timeout: 8000,
      });
    }
  }, [canOperate, recordingSlotId, stopPreview, stopRecorder, t]);

  const previewSlot = useCallback(async (slot: VoiceKeyerSlot) => {
    if (!callsign || !slot.hasAudio) return;
    if (previewPlayingSlotId === slot.id) {
      stopPreview();
      return;
    }

    stopPreview();
    setPreviewLoadingSlotId(slot.id);
    try {
      const blob = await api.getVoiceKeyerSlotAudio(callsign, slot.id);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewUrlRef.current = url;
      previewAudioRef.current = audio;
      audio.onended = () => {
        if (previewAudioRef.current === audio) {
          stopPreview();
        }
      };
      await audio.play();
      if (previewAudioRef.current === audio) {
        setPreviewPlayingSlotId(slot.id);
      }
    } catch (error) {
      logger.error('Failed to preview voice keyer slot', error);
      stopPreview();
      addToast({ title: t('keyer.previewFailed'), color: 'danger', timeout: 4000 });
    } finally {
      setPreviewLoadingSlotId(current => current === slot.id ? null : current);
    }
  }, [callsign, previewPlayingSlotId, stopPreview, t]);

  const updateSlot = useCallback(async (
    slotId: string,
    update: Partial<Pick<VoiceKeyerSlot, 'label' | 'repeatEnabled' | 'repeatIntervalSec'>>,
  ): Promise<VoiceKeyerPanel | null> => {
    if (!callsign) return null;
    try {
      const response = await api.updateVoiceKeyerSlot(callsign, slotId, update);
      setPanel(response.panel);
      return response.panel;
    } catch (error) {
      logger.error('Failed to update voice keyer slot', error);
      return null;
    }
  }, [callsign]);

  const updateSlotLocal = useCallback((slotId: string, update: Partial<Pick<VoiceKeyerSlot, 'label' | 'repeatEnabled' | 'repeatIntervalSec'>>) => {
    setPanel(current => current ? {
      ...current,
      slots: current.slots.map(item => item.id === slotId ? { ...item, ...update } : item),
    } : current);
  }, []);

  const queueSlotUpdate = useCallback((slotId: string, update: Partial<Pick<VoiceKeyerSlot, 'repeatEnabled' | 'repeatIntervalSec'>>) => {
    const timers = slotUpdateTimersRef.current;
    if (timers[slotId]) window.clearTimeout(timers[slotId]);
    timers[slotId] = window.setTimeout(() => {
      delete timers[slotId];
      void updateSlot(slotId, update);
    }, 350);
  }, [updateSlot]);

  const updateSlotCount = useCallback(async (slotCount: number) => {
    if (!callsign) return;
    try {
      const response = await api.updateVoiceKeyerPanel(callsign, { slotCount });
      setPanel(response.panel);
    } catch (error) {
      logger.error('Failed to update voice keyer slot count', error);
    }
  }, [callsign]);

  const deleteSlot = useCallback(async (slot: VoiceKeyerSlot) => {
    if (!callsign || !slot.hasAudio) return;
    setBusySlotId(slot.id);
    try {
      const response = await api.deleteVoiceKeyerSlot(callsign, slot.id);
      setPanel(response.panel);
    } catch (error) {
      logger.error('Failed to delete voice keyer slot', error);
      addToast({ title: t('keyer.deleteFailed'), color: 'danger', timeout: 4000 });
    } finally {
      setBusySlotId(null);
    }
  }, [callsign, t]);

  const playSlot = useCallback((slot: VoiceKeyerSlot, repeat = false, startImmediately = true) => {
    if (!canOperate || !slot.hasAudio || !callsign) return;
    stopPreview();
    radioService?.playVoiceKeyer(callsign, slot.id, repeat, startImmediately);
  }, [callsign, canOperate, radioService, stopPreview]);

  const stopKeyer = useCallback(() => {
    radioService?.stopVoiceKeyer();
  }, [radioService]);

  const toggleRepeat = useCallback(async (slot: VoiceKeyerSlot) => {
    const repeatEnabled = !slot.repeatEnabled;
    updateSlotLocal(slot.id, { repeatEnabled });
    const updatedPanel = await updateSlot(slot.id, { repeatEnabled });
    if (!updatedPanel) {
      updateSlotLocal(slot.id, { repeatEnabled: slot.repeatEnabled });
      return;
    }

    const updatedSlot = updatedPanel.slots.find(candidate => candidate.id === slot.id) ?? slot;
    const activeOnThisSlot = activeForCallsign && status.slotId === slot.id;
    if (repeatEnabled) {
      playSlot(updatedSlot, true, false);
    } else if (activeOnThisSlot) {
      stopKeyer();
    }
  }, [activeForCallsign, playSlot, status.slotId, stopKeyer, updateSlot, updateSlotLocal]);

  const changePanelMode = useCallback((mode: KeyerPanelMode) => {
    if (mode === panelMode) return;
    if (mode === 'operate') {
      void stopRecorder(false);
      stopPreview();
    }
    setPanelMode(mode);
  }, [panelMode, stopPreview, stopRecorder]);

  const getShortcutOptionLabel = useCallback((preset: VoiceKeyerShortcutPreset): string => (
    preset === VOICE_KEYER_SHORTCUT_NONE ? t('keyer.shortcutNone') : preset
  ), [t]);

  const updateSlotShortcut = useCallback((slot: VoiceKeyerSlot, preset: VoiceKeyerShortcutPreset) => {
    const nextShortcuts = { ...slotShortcuts };
    const changes: Array<{ slotId: string; preset: VoiceKeyerShortcutPreset }> = [];

    if (preset !== VOICE_KEYER_SHORTCUT_NONE) {
      for (const candidate of panel?.slots ?? []) {
        if (candidate.id !== slot.id && nextShortcuts[candidate.id] === preset) {
          nextShortcuts[candidate.id] = VOICE_KEYER_SHORTCUT_NONE;
          changes.push({ slotId: candidate.id, preset: VOICE_KEYER_SHORTCUT_NONE });
        }
      }
    }

    nextShortcuts[slot.id] = preset;
    changes.push({ slotId: slot.id, preset });

    setSlotShortcuts(nextShortcuts);
    for (const change of changes) {
      saveVoiceKeyerSlotShortcutPreset(callsign, change.slotId, change.preset);
    }
    setShortcutMenuSlotId(null);
  }, [callsign, panel?.slots, slotShortcuts]);

  useEffect(() => {
    if (!shortcutMenuSlotId) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-voice-keyer-shortcut-menu]')) {
        return;
      }

      setShortcutMenuSlotId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShortcutMenuSlotId(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [shortcutMenuSlotId]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Escape' && status.active) {
        event.preventDefault();
        stopKeyer();
        return;
      }
      const slot = visibleSlots.find(candidate => (
        matchesVoiceKeyerShortcut(event.code, slotShortcuts[candidate.id] ?? VOICE_KEYER_SHORTCUT_NONE)
      ));
      if (panelMode !== 'operate' || !slot || !slot.hasAudio || !canOperate) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      playSlot(slot, slot.repeatEnabled);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [canOperate, panelMode, playSlot, slotShortcuts, status.active, stopKeyer, visibleSlots]);

  useEffect(() => () => {
    Object.values(slotUpdateTimersRef.current).forEach(timer => window.clearTimeout(timer));
    slotUpdateTimersRef.current = {};
    void stopRecorder(false);
    stopPreview();
  }, [stopPreview, stopRecorder]);

  const statusText = useMemo(() => {
    if (!status.active) return hasCallsign ? callsign : t('keyer.noCallsign');
    if (status.mode === 'repeat-waiting' && status.nextRunAt) {
      const seconds = Math.max(0, Math.ceil((status.nextRunAt - Date.now()) / 1000));
      return t('keyer.waiting', { callsign: status.callsign, seconds });
    }
    if (status.mode === 'repeat-waiting') return t('keyer.waitingForPtt', { callsign: status.callsign });
    if (status.mode === 'playing') return t('keyer.transmittingSlot', { callsign: status.callsign, slot: status.slotId });
    if (status.mode === 'stopping') return t('keyer.stopping');
    if (status.mode === 'error') return t('keyer.error');
    return callsign;
  }, [callsign, hasCallsign, status.active, status.callsign, status.mode, status.nextRunAt, status.slotId, t, tick]);

  return (
    <Card className="w-full" shadow="sm">
      <CardHeader
        className="flex items-center justify-between gap-2 cursor-pointer select-none py-2"
        onClick={() => setIsCollapsed(prev => !prev)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <FontAwesomeIcon
            icon={faChevronRight}
            className={`text-default-400 text-xs transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
          />
          <span className="text-sm font-semibold whitespace-nowrap">{t('keyer.title')}</span>
          <span className={`truncate text-xs font-mono ${status.active ? 'text-danger' : 'text-default-500'}`}>
            {statusText}
          </span>
        </div>

        <div
          className="flex shrink-0 items-center gap-1.5"
          onClick={(event) => event.stopPropagation()}
        >
          {!isCollapsed && (
            <Tabs
              aria-label={t('keyer.modeTabs')}
              selectedKey={panelMode}
              onSelectionChange={(key) => changePanelMode(key as KeyerPanelMode)}
              size="sm"
              variant="solid"
              classNames={{
                base: 'shrink-0',
                tabList: 'h-7 gap-0 p-0.5',
                tab: 'h-6 px-2',
                tabContent: 'text-xs',
              }}
            >
              <Tab
                key="operate"
                title={(
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faTowerBroadcast} className="text-[10px]" />
                    {t('keyer.operateMode')}
                  </span>
                )}
              />
              <Tab
                key="edit"
                title={(
                  <span className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faPen} className="text-[10px]" />
                    {t('keyer.editMode')}
                  </span>
                )}
              />
            </Tabs>
          )}
          {operators.length > 0 && (
            <Select
              size="sm"
              variant="flat"
              aria-label={t('qso.operator')}
              selectedKeys={selectedOperatorId ? [selectedOperatorId] : []}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                if (selected) {
                  setSelectedOperatorId(selected);
                  setCurrentOperatorId(selected);
                }
              }}
              className="w-36"
              classNames={{ trigger: 'h-7 min-h-7', value: 'font-mono text-xs' }}
            >
              {operators.map((op) => (
                <SelectItem key={op.id} textValue={op.context.myCall || op.id}>
                  {op.context.myCall || op.id}
                </SelectItem>
              ))}
            </Select>
          )}
          {panel && !isCollapsed && (
            <Select
              size="sm"
              variant="flat"
              aria-label={t('keyer.slotCount')}
              selectedKeys={[String(panel.slotCount)]}
              onSelectionChange={(keys) => {
                const selected = Number(Array.from(keys)[0]);
                if (selected) void updateSlotCount(selected);
              }}
              className="w-16 sm:w-20"
              classNames={{ trigger: 'h-7 min-h-7', value: 'text-xs' }}
            >
              {[3, 4, 5, 6, 8, 10, 12].map((count) => (
                <SelectItem key={String(count)} textValue={String(count)}>{count}</SelectItem>
              ))}
            </Select>
          )}
        </div>
      </CardHeader>

      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: isCollapsed ? '0fr' : '1fr' }}
      >
        <div className="overflow-hidden">
          <CardBody className="pt-0">
            {!canOperate && (
              <div className="rounded-md bg-warning-50 px-2 py-1.5 text-xs text-warning dark:bg-warning-50/10">
                {hasCallsign ? t('keyer.operatorRequired') : t('keyer.noOperator')}
              </div>
            )}
            {loading && (
              <div className="flex items-center gap-2 py-2 text-xs text-default-500">
                <Spinner size="sm" />
                {t('keyer.loading')}
              </div>
            )}
            {panel && (
              <div className="pb-1">
                <div
                  className={
                    panelMode === 'operate'
                      ? 'grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2'
                      : 'grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,7.5rem),1fr))] gap-2'
                  }
                >
                  {visibleSlots.map((slot) => {
                    const recording = recordingSlotId === slot.id;
                    const busy = busySlotId === slot.id;
                    const active = activeSlot === slot.id;
                    const intervalValue = Math.max(1, Math.min(300, Math.round(Number(slot.repeatIntervalSec) || 1)));
                    const inputLevelPercent = Math.round(recordingInputLevel * 100);
                    const previewLoading = previewLoadingSlotId === slot.id;
                    const previewPlaying = previewPlayingSlotId === slot.id;
                    const shortcutPreset = slotShortcuts[slot.id] ?? VOICE_KEYER_SHORTCUT_NONE;
                    if (panelMode === 'operate') {
                      const transmitting = active && status.mode === 'playing';
                      return (
                        <div
                          key={slot.id}
                          className={`rounded-lg p-2 transition-colors ${
                            active ? 'bg-danger-50 dark:bg-danger-950/20' : 'bg-content2'
                          }`}
                        >
                          <Button
                            color={transmitting ? 'danger' : active ? 'warning' : 'primary'}
                            variant={transmitting ? 'solid' : active ? 'flat' : 'solid'}
                            className="relative h-16 w-full overflow-hidden rounded-md px-2"
                            onPress={() => active ? stopKeyer() : playSlot(slot, slot.repeatEnabled)}
                            isDisabled={!slot.hasAudio || !canOperate || (status.active && !active)}
                          >
                            {transmitting && (
                              <span
                                key={`${slot.id}-${txProgressRunId}`}
                                className="voice-keyer-tx-progress absolute inset-y-0 left-0 pointer-events-none bg-white/25"
                                style={getTxProgressStyle(slot.durationMs)}
                              />
                            )}
                            <div className="relative z-10 flex w-full flex-col items-start gap-1 text-left">
                              <div className="flex w-full items-center justify-between gap-1">
                                <span className="font-mono text-xs font-semibold">
                                  {getShortcutOptionLabel(shortcutPreset)}
                                </span>
                                <span className="text-[11px] opacity-80">{formatDuration(slot.durationMs)}</span>
                              </div>
                              <span className="max-w-full truncate text-sm font-semibold">
                                {slot.hasAudio ? slot.label : t('keyer.emptySlot')}
                              </span>
                            </div>
                          </Button>
                          <div className="mt-2 flex items-center gap-1">
                            <Button
                              isIconOnly
                              size="sm"
                              color={slot.repeatEnabled ? 'warning' : 'default'}
                              variant={slot.repeatEnabled ? 'solid' : 'flat'}
                              aria-label={t('keyer.repeatToggle')}
                              onPress={() => void toggleRepeat(slot)}
                              isDisabled={!canOperate || !slot.hasAudio}
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
                              aria-label={t('keyer.repeatInterval')}
                              endContent={<span className="text-[11px] text-default-400">s</span>}
                              classNames={{ inputWrapper: 'h-7 min-h-7 px-2', input: 'text-xs font-mono' }}
                              onValueChange={(value) => {
                                const repeatIntervalSec = Math.max(1, Math.min(300, Math.round(Number(value) || 1)));
                                updateSlotLocal(slot.id, { repeatIntervalSec });
                                queueSlotUpdate(slot.id, { repeatIntervalSec });
                              }}
                              isDisabled={!canOperate || !slot.hasAudio}
                            />
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={slot.id}
                        className={`rounded-lg p-2 transition-colors ${
                          active ? 'bg-danger-50 dark:bg-danger-950/20' : 'bg-content2'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <div
                            data-voice-keyer-shortcut-menu
                            className="relative"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onTouchStart={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              aria-label={t('keyer.shortcutSelectAria', { slot: slot.index })}
                              className="flex h-6 min-w-10 items-center gap-0.5 rounded-md bg-default-100 px-1.5 font-mono text-xs font-semibold text-default-700 outline-none transition-colors hover:bg-default-200 disabled:opacity-50 dark:bg-default-100/10 dark:text-default-300 dark:hover:bg-default-100/20"
                              disabled={!canOperate}
                              onClick={() => {
                                setShortcutMenuSlotId(current => current === slot.id ? null : slot.id);
                              }}
                            >
                              <span>{getShortcutOptionLabel(shortcutPreset)}</span>
                              <ShortcutChevronIcon open={shortcutMenuSlotId === slot.id} />
                            </button>
                            {shortcutMenuSlotId === slot.id && (
                              <div className="absolute bottom-full left-0 z-50 mb-1 min-w-16 rounded-md border border-divider bg-content1 p-1 shadow-lg">
                                {VOICE_KEYER_SHORTCUT_PRESETS.map((preset) => {
                                  const selected = preset === shortcutPreset;

                                  return (
                                    <button
                                      key={preset}
                                      type="button"
                                      className={`flex h-6 w-full items-center justify-between gap-2 rounded px-2 text-left text-xs font-medium transition-colors ${
                                        selected
                                          ? 'bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300'
                                          : 'text-default-700 hover:bg-default-100 dark:text-default-300 dark:hover:bg-default-100/10'
                                      }`}
                                      onClick={() => updateSlotShortcut(slot, preset)}
                                    >
                                      <span className="whitespace-nowrap">{getShortcutOptionLabel(preset)}</span>
                                      {selected ? <span className="text-[10px] opacity-70">✓</span> : null}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          <span className="text-[11px] text-default-500">{formatDuration(slot.durationMs)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          <FontAwesomeIcon icon={faPen} className="text-[10px] text-default-400" />
                          <Input
                            size="sm"
                            variant="flat"
                            value={slot.label}
                            aria-label={t('keyer.slotLabel')}
                            classNames={{ input: 'text-xs font-medium', inputWrapper: 'h-7 min-h-7 px-2' }}
                            onValueChange={(value) => updateSlotLocal(slot.id, { label: value })}
                            onBlur={(event) => void updateSlot(slot.id, { label: event.currentTarget.value })}
                            isDisabled={!canOperate}
                          />
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-1">
                          <Button
                            isIconOnly
                            size="sm"
                            color={recording ? 'danger' : 'default'}
                            variant={recording ? 'solid' : 'flat'}
                            aria-label={recording ? t('keyer.stopRecording') : t('keyer.record')}
                            onPress={() => recording ? void stopRecorder(true) : void startRecording(slot.id)}
                            isDisabled={!canOperate || busy || Boolean(recordingSlotId && !recording)}
                            className="h-7 w-full min-w-0 rounded-md"
                          >
                            <FontAwesomeIcon icon={faCircle} className={`text-[10px] ${recording ? 'animate-pulse' : ''}`} />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            color={previewPlaying ? 'success' : 'default'}
                            variant={previewPlaying ? 'solid' : 'flat'}
                            aria-label={previewPlaying ? t('keyer.stopPreview') : t('keyer.preview')}
                            onPress={() => void previewSlot(slot)}
                            isLoading={previewLoading}
                            isDisabled={!slot.hasAudio || busy || recording || !canOperate || Boolean(previewLoadingSlotId && !previewLoading)}
                            className="h-7 w-full min-w-0 rounded-md"
                          >
                            <FontAwesomeIcon icon={previewPlaying ? faStop : faPlay} className="text-xs" />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            aria-label={t('keyer.delete')}
                            onPress={() => void deleteSlot(slot)}
                            isDisabled={!slot.hasAudio || recording || !canOperate}
                            className="h-7 w-full min-w-0 rounded-md"
                          >
                            <FontAwesomeIcon icon={faTrash} className="text-xs" />
                          </Button>
                        </div>
                        {recording ? (
                          <div className="mt-1 flex h-6 items-center gap-1 rounded-md bg-danger-50 px-1.5 text-danger dark:bg-danger-950/20">
                            <span className="shrink-0 text-[10px] font-semibold uppercase">{t('keyer.recordingActive')}</span>
                            <div
                              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-danger-100 dark:bg-danger-900/50"
                              aria-label={t('keyer.recordingLevel')}
                              role="meter"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={inputLevelPercent}
                            >
                              <div
                                className="h-full rounded-full bg-danger transition-[width] duration-75"
                                style={{ width: `${inputLevelPercent}%` }}
                              />
                            </div>
                            <span
                              className="shrink-0 font-mono text-[10px]"
                              aria-label={t('keyer.recordingElapsed')}
                            >
                              {formatRecordingElapsed(recordingElapsedMs)}
                            </span>
                          </div>
                        ) : (
                          <div className="mt-1 flex h-6 items-center gap-1 text-[11px] text-default-500">
                            <Button
                              isIconOnly
                              size="sm"
                              color={slot.repeatEnabled ? 'warning' : 'default'}
                              variant="flat"
                              aria-label={t('keyer.repeatToggle')}
                              onPress={() => void toggleRepeat(slot)}
                              isDisabled={!canOperate || !slot.hasAudio}
                              className="h-6 min-w-6 rounded-md"
                            >
                              <FontAwesomeIcon icon={active && status.mode === 'repeat-waiting' ? faPause : faRepeat} className="text-[10px]" />
                            </Button>
                            <Input
                              type="number"
                              min={1}
                              max={300}
                              size="sm"
                              variant="flat"
                              value={String(intervalValue)}
                              aria-label={t('keyer.repeatInterval')}
                              classNames={{ inputWrapper: 'h-6 min-h-6 px-1', input: 'text-[11px]' }}
                              onValueChange={(value) => updateSlotLocal(slot.id, { repeatIntervalSec: Math.max(1, Math.min(300, Math.round(Number(value) || 1))) })}
                              onBlur={(event) => void updateSlot(slot.id, { repeatIntervalSec: Number(event.currentTarget.value) || 1 })}
                              isDisabled={!canOperate}
                            />
                            <span>s</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardBody>
        </div>
      </div>
    </Card>
  );
};
