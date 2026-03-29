import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Slider, Tab, Tabs, Tooltip } from '@heroui/react';
import { ArrowsPointingOutIcon, Cog6ToothIcon, MinusIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { SpectrumFrame, SpectrumKind } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useConnection, useCurrentOperatorId, useOperators, useProfiles, useRadioState, useSpectrum } from '../store/radioStore';
import { createLogger } from '../utils/logger';
import { setPreferredSpectrumKind } from '../utils/spectrumPreferences';
import { useTargetRxFrequencies } from '../hooks/useTargetRxFrequencies';
import { useTxFrequencies } from '../hooks/useTxFrequencies';
import { WebGLWaterfall } from './WebGLWaterfall';
import type { AutoRangeConfig, TxBandOverlay } from './WebGLWaterfall';

const logger = createLogger('SpectrumDisplay');

type ElectronWindowHelper = Window & {
  electronAPI?: {
    window: {
      openSpectrumWindow: () => Promise<void>;
    };
  };
};

const WATERFALL_HISTORY = 120;
const WATERFALL_UPDATE_INTERVAL = 100;
const SETTINGS_STORAGE_KEY = 'spectrum-range-settings';
const OPENWEBRX_VIEWPORT_STORAGE_KEY = 'openwebrx-spectrum-viewports';
const AUDIO_SOURCE: SpectrumKind = 'audio';
const RADIO_SDR_SOURCE: SpectrumKind = 'radio-sdr';
const OPENWEBRX_SDR_SOURCE: SpectrumKind = 'openwebrx-sdr';
const BASEBAND_INTERACTION_RANGE = { min: 0, max: 3000 };
const OPENWEBRX_MIN_VIEWPORT_SPAN_HZ = 1000;
const OPENWEBRX_MAX_ZOOM_STEPS = 32;

const DEFAULT_AUTO_CONFIG: AutoRangeConfig = {
  updateInterval: 10,
  minPercentile: 15,
  maxPercentile: 99,
  rangeExpansionFactor: 4.0,
};

interface SpectrumDisplayProps {
  className?: string;
  height?: number;
  hoverFrequency?: number | null;
  showPopOut?: boolean;
  onPopOutChange?: (isPopedOut: boolean) => void;
  showMarkers?: boolean;
}

interface WaterfallData {
  spectrumData: number[][];
  frequencies: number[];
  timeLabels: string[];
}

interface ManualRangeSettings {
  minDb: number;
  maxDb: number;
}

interface AudioRangeSettings {
  mode: 'auto' | 'manual';
  manual: ManualRangeSettings;
  auto: AutoRangeConfig;
}

interface PersistedRangeSettings {
  audio: AudioRangeSettings;
  radioSdr: ManualRangeSettings;
  openWebRxSdr: ManualRangeSettings;
}

interface OpenWebRXViewport {
  centerHz: number;
  spanHz: number;
}

interface OpenWebRXViewportStore {
  profiles: Record<string, OpenWebRXViewport>;
}

const AUDIO_RANGE_LIMITS = {
  min: -120,
  max: 40,
};

const RADIO_SDR_RANGE_LIMITS = {
  min: -64,
  max: 255,
};

const OPENWEBRX_RANGE_LIMITS = {
  min: -140,
  max: 20,
};

const DEFAULT_OPENWEBRX_RANGE_SETTINGS: ManualRangeSettings = {
  minDb: -120,
  maxDb: 0,
};

const DEFAULT_PERSISTED_RANGE_SETTINGS: PersistedRangeSettings = {
  audio: {
    mode: 'auto',
    manual: {
      minDb: -35,
      maxDb: 10,
    },
    auto: DEFAULT_AUTO_CONFIG,
  },
  radioSdr: {
    minDb: 0,
    maxDb: 64,
  },
  openWebRxSdr: {
    minDb: DEFAULT_OPENWEBRX_RANGE_SETTINGS.minDb,
    maxDb: DEFAULT_OPENWEBRX_RANGE_SETTINGS.maxDb,
  },
};

function cloneManualRangeSettings(settings: ManualRangeSettings): ManualRangeSettings {
  return {
    minDb: settings.minDb,
    maxDb: settings.maxDb,
  };
}

function cloneAudioRangeSettings(settings: AudioRangeSettings): AudioRangeSettings {
  return {
    mode: settings.mode,
    manual: cloneManualRangeSettings(settings.manual),
    auto: { ...settings.auto },
  };
}

function normalizeManualRangeSettings(
  settings: Partial<ManualRangeSettings> | null | undefined,
  fallback: ManualRangeSettings
): ManualRangeSettings {
  const minDb = typeof settings?.minDb === 'number' ? settings.minDb : fallback.minDb;
  const maxDb = typeof settings?.maxDb === 'number' ? settings.maxDb : fallback.maxDb;

  return {
    minDb,
    maxDb: maxDb > minDb ? maxDb : minDb + 1,
  };
}

function clampRangeValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeAudioRangeSettings(
  settings: Partial<AudioRangeSettings> | null | undefined,
  fallback: AudioRangeSettings
): AudioRangeSettings {
  return {
    mode: settings?.mode === 'manual' ? 'manual' : 'auto',
    manual: normalizeManualRangeSettings(settings?.manual, fallback.manual),
    auto: {
      updateInterval: typeof settings?.auto?.updateInterval === 'number' ? settings.auto.updateInterval : fallback.auto.updateInterval,
      minPercentile: typeof settings?.auto?.minPercentile === 'number' ? settings.auto.minPercentile : fallback.auto.minPercentile,
      maxPercentile: typeof settings?.auto?.maxPercentile === 'number' ? settings.auto.maxPercentile : fallback.auto.maxPercentile,
      rangeExpansionFactor: typeof settings?.auto?.rangeExpansionFactor === 'number'
        ? settings.auto.rangeExpansionFactor
        : fallback.auto.rangeExpansionFactor,
    },
  };
}

function loadPersistedRangeSettings(): PersistedRangeSettings {
  const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!saved) {
      return {
        audio: cloneAudioRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.audio),
        radioSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
        openWebRxSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr),
      };
  }

  try {
    const parsed = JSON.parse(saved) as
      | Partial<PersistedRangeSettings>
      | { manual?: Partial<ManualRangeSettings>; auto?: Partial<AutoRangeConfig>; mode?: 'auto' | 'manual' };

    if (typeof parsed === 'object' && parsed !== null && ('audio' in parsed || 'radioSdr' in parsed)) {
      return {
        audio: normalizeAudioRangeSettings(
          (parsed as Partial<PersistedRangeSettings>).audio,
          DEFAULT_PERSISTED_RANGE_SETTINGS.audio
        ),
        radioSdr: normalizeManualRangeSettings(
          (parsed as Partial<PersistedRangeSettings>).radioSdr,
          DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr
        ),
        openWebRxSdr: normalizeManualRangeSettings(
          (parsed as Partial<PersistedRangeSettings>).openWebRxSdr,
          DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr
        ),
      };
    }

    return {
      audio: normalizeAudioRangeSettings(
        parsed as { manual?: Partial<ManualRangeSettings>; auto?: Partial<AutoRangeConfig>; mode?: 'auto' | 'manual' },
        DEFAULT_PERSISTED_RANGE_SETTINGS.audio
      ),
      radioSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
      openWebRxSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr),
    };
  } catch (error) {
    logger.error('Failed to parse saved settings', error);
    return {
      audio: cloneAudioRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.audio),
      radioSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
      openWebRxSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr),
    };
  }
}

function readOpenWebRXViewportStore(): OpenWebRXViewportStore {
  try {
    const raw = localStorage.getItem(OPENWEBRX_VIEWPORT_STORAGE_KEY);
    if (!raw) {
      return { profiles: {} };
    }

    const parsed = JSON.parse(raw) as Partial<OpenWebRXViewportStore>;
    return {
      profiles: parsed.profiles ?? {},
    };
  } catch (error) {
    logger.warn('Failed to read OpenWebRX viewport store', error);
    return { profiles: {} };
  }
}

function writeOpenWebRXViewport(profileId: string | null, viewport: OpenWebRXViewport | null): void {
  if (!profileId) {
    return;
  }

  try {
    const store = readOpenWebRXViewportStore();
    if (viewport) {
      store.profiles[profileId] = viewport;
    } else {
      delete store.profiles[profileId];
    }
    localStorage.setItem(OPENWEBRX_VIEWPORT_STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    logger.warn('Failed to persist OpenWebRX viewport', error);
  }
}

function readOpenWebRXViewport(profileId: string | null): OpenWebRXViewport | null {
  if (!profileId) {
    return null;
  }
  return readOpenWebRXViewportStore().profiles[profileId] ?? null;
}

function clampOpenWebRXViewport(
  viewport: OpenWebRXViewport,
  fullMin: number,
  fullMax: number
): OpenWebRXViewport {
  const totalSpan = Math.max(fullMax - fullMin, 1);
  const minSpan = Math.min(totalSpan, Math.max(OPENWEBRX_MIN_VIEWPORT_SPAN_HZ, totalSpan / OPENWEBRX_MAX_ZOOM_STEPS));
  const spanHz = Math.min(totalSpan, Math.max(minSpan, viewport.spanHz));
  const halfSpan = spanHz / 2;
  const minCenter = fullMin + halfSpan;
  const maxCenter = fullMax - halfSpan;
  const centerHz = Math.min(maxCenter, Math.max(minCenter, viewport.centerHz));

  return {
    centerHz,
    spanHz,
  };
}

function buildOpenWebRXZoomLevels(totalSpan: number): number[] {
  const levels = new Set<number>();
  const minSpan = Math.min(totalSpan, Math.max(OPENWEBRX_MIN_VIEWPORT_SPAN_HZ, totalSpan / OPENWEBRX_MAX_ZOOM_STEPS));

  let currentSpan = totalSpan;
  levels.add(Math.round(totalSpan));
  while (currentSpan > minSpan) {
    currentSpan = Math.max(minSpan, currentSpan / 2);
    levels.add(Math.round(currentSpan));
    if (currentSpan === minSpan) {
      break;
    }
  }

  return Array.from(levels).sort((a, b) => b - a);
}

function cropSpectrumToViewport(
  values: number[],
  fullRange: { min: number; max: number },
  viewport: OpenWebRXViewport
): number[] {
  if (values.length === 0) {
    return values;
  }

  const fullSpan = fullRange.max - fullRange.min;
  if (fullSpan <= 0) {
    return values;
  }

  const viewMin = viewport.centerHz - viewport.spanHz / 2;
  const viewMax = viewport.centerHz + viewport.spanHz / 2;
  const output = new Array<number>(values.length);
  const maxIndex = values.length - 1;

  for (let i = 0; i < values.length; i++) {
    const targetFrequency = viewMin + (i * (viewMax - viewMin)) / Math.max(values.length - 1, 1);
    const sourceRatio = (targetFrequency - fullRange.min) / fullSpan;
    const sourcePos = Math.min(maxIndex, Math.max(0, sourceRatio * maxIndex));
    const left = Math.floor(sourcePos);
    const right = Math.min(maxIndex, left + 1);
    const factor = sourcePos - left;
    output[i] = values[left] + (values[right] - values[left]) * factor;
  }

  return output;
}

export const SpectrumDisplay: React.FC<SpectrumDisplayProps> = ({
  className = '',
  height = 200,
  hoverFrequency,
  showPopOut = true,
  onPopOutChange,
  showMarkers = true,
}) => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const { operators } = useOperators();
  const { activeProfileId } = useProfiles();
  const { state: radioState } = useRadioState();
  const { capabilities, selectedKind, latestFrame, setSelectedKind, zoomState, digitalWindowState } = useSpectrum();
  const isTransmitting = radioState.pttStatus.isTransmitting;
  const [frame, setFrame] = useState<SpectrumFrame | null>(null);
  const [waterfallData, setWaterfallData] = useState<WaterfallData>({
    spectrumData: [],
    frequencies: [],
    timeLabels: [],
  });
  const [actualRange, setActualRange] = useState<{ min: number; max: number } | null>(null);
  const [persistedRangeSettings, setPersistedRangeSettings] = useState<PersistedRangeSettings>(() => loadPersistedRangeSettings());
  const [openWebRXViewport, setOpenWebRXViewport] = useState<OpenWebRXViewport | null>(() => readOpenWebRXViewport(activeProfileId));
  const lastUpdateRef = useRef<number>(0);
  const pendingFrameRef = useRef<SpectrumFrame | null>(null);
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const openWebRXPanStateRef = useRef<{ startX: number; startCenterHz: number; width: number } | null>(null);
  const openWebRXHistoryRef = useRef<Array<{ frame: SpectrumFrame; values: number[]; timeLabel: string }>>([]);

  const isElectron = typeof window !== 'undefined' && (window as ElectronWindowHelper).electronAPI !== undefined;
  const canPopOut = showPopOut && isElectron;
  const rxFrequencies = useTargetRxFrequencies();
  const txFrequencies = useTxFrequencies();
  const { currentOperatorId } = useCurrentOperatorId();
  const effectiveSelectedKind = selectedKind ?? capabilities?.defaultKind ?? AUDIO_SOURCE;
  const isRadioSdrSelected = effectiveSelectedKind === RADIO_SDR_SOURCE;
  const isOpenWebRXSdrSelected = effectiveSelectedKind === OPENWEBRX_SDR_SOURCE;
  const isVoiceMode = radioState.engineMode === 'voice';
  const radioViewState = radioState.radioViewState;
  const spectrumDisplayState = radioState.spectrumDisplayState;
  const isFixedSpectrumMode = isRadioSdrSelected
    && (spectrumDisplayState?.mode === 'fixed' || spectrumDisplayState?.mode === 'scroll-fixed');
  const frequencyRangeMode = isOpenWebRXSdrSelected
    ? 'absolute-windowed'
    : !isRadioSdrSelected
    ? 'baseband'
    : isFixedSpectrumMode
      ? 'absolute-fixed'
      : 'absolute-center';
  const spectrumReferenceFrequency = isRadioSdrSelected
    ? (spectrumDisplayState?.currentRadioFrequency ?? radioState.currentRadioFrequency ?? null)
    : null;
  const currentManualRangeSettings = isOpenWebRXSdrSelected
    ? persistedRangeSettings.openWebRxSdr
    : isRadioSdrSelected
      ? persistedRangeSettings.radioSdr
    : persistedRangeSettings.audio.manual;
  const audioRangeSettings = persistedRangeSettings.audio;
  const rangeLimits = isOpenWebRXSdrSelected
    ? OPENWEBRX_RANGE_LIMITS
    : isRadioSdrSelected
      ? RADIO_SDR_RANGE_LIMITS
      : AUDIO_RANGE_LIMITS;

  const updateCurrentRangeSettings = useCallback((updater: (current: ManualRangeSettings) => ManualRangeSettings) => {
    setPersistedRangeSettings(prev => {
      if (isRadioSdrSelected) {
        return {
          ...prev,
          radioSdr: updater(prev.radioSdr),
        };
      }

      if (isOpenWebRXSdrSelected) {
        return {
          ...prev,
          openWebRxSdr: updater(prev.openWebRxSdr),
        };
      }

      return {
        ...prev,
        audio: updater(prev.audio),
      };
    });
  }, [isOpenWebRXSdrSelected, isRadioSdrSelected]);

  const updateAudioRangeSettings = useCallback((updater: (current: AudioRangeSettings) => AudioRangeSettings) => {
    setPersistedRangeSettings(prev => ({
      ...prev,
      audio: updater(prev.audio),
    }));
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(persistedRangeSettings));
  }, [persistedRangeSettings]);

  useEffect(() => {
    setOpenWebRXViewport(readOpenWebRXViewport(activeProfileId));
  }, [activeProfileId]);

  useEffect(() => {
    writeOpenWebRXViewport(activeProfileId, openWebRXViewport);
  }, [activeProfileId, openWebRXViewport]);

  const handlePopOut = useCallback(async () => {
    try {
      await (window as ElectronWindowHelper).electronAPI!.window.openSpectrumWindow();
      onPopOutChange?.(true);
    } catch (error) {
      logger.error('Failed to open spectrum window', error);
    }
  }, [onPopOutChange]);

  const handleTxFrequencyChange = useCallback((operatorId: string, frequency: number) => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    const operator = operators.find(op => op.id === operatorId);
    if (!operator) return;

    radioService.setOperatorContext(operatorId, {
      myCall: operator.context.myCall,
      myGrid: operator.context.myGrid,
      targetCallsign: operator.context.targetCall,
      targetGrid: operator.context.targetGrid,
      frequency: Math.round(frequency),
      reportSent: operator.context.reportSent,
      reportReceived: operator.context.reportReceived,
    });
  }, [connection.state.radioService, operators]);

  const handleRightClickSetFrequency = useCallback((frequency: number) => {
    if (currentOperatorId) {
      handleTxFrequencyChange(currentOperatorId, frequency);
    }
  }, [currentOperatorId, handleTxFrequencyChange]);

  const handleVoiceFrequencyChange = useCallback(async (frequency: number) => {
    if (!connection.state.isConnected) {
      return;
    }

    const currentRadioMode = radioViewState?.radioMode ?? radioState.currentRadioMode ?? 'USB';

    try {
      await api.setRadioFrequency({
        frequency: Math.round(frequency),
        mode: 'VOICE',
        band: 'Custom',
        description: `${(frequency / 1_000_000).toFixed(3)} MHz`,
        radioMode: currentRadioMode,
      });
    } catch (error) {
      logger.error('Failed to set voice frequency from SDR overlay', error);
    }
  }, [connection.state.isConnected, radioState.currentRadioMode, radioViewState?.radioMode]);

  const decodeSpectrumData = useCallback((nextFrame: SpectrumFrame) => {
    const binaryString = atob(nextFrame.binaryData.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const int16Array = new Int16Array(bytes.buffer);
    const { scale = 1, offset = 0 } = nextFrame.binaryData.format;
    return Array.from(int16Array, value => value * scale + offset);
  }, []);

  const getSpectrumBinCount = useCallback((nextFrame: SpectrumFrame) => {
    return nextFrame.meta?.displayBinCount
      ?? nextFrame.meta?.sourceBinCount
      ?? decodeSpectrumData(nextFrame).length;
  }, [decodeSpectrumData]);

  const generateFrequencyAxis = useCallback((nextFrame: SpectrumFrame) => {
    const { min, max } = nextFrame.frequencyRange;
    const length = getSpectrumBinCount(nextFrame);
    const frequencies = new Array(length);

    for (let i = 0; i < length; i++) {
      frequencies[i] = min + (i * (max - min)) / Math.max(length - 1, 1);
    }

    return frequencies;
  }, [getSpectrumBinCount]);

  const resetWaterfall = useCallback(() => {
    setFrame(null);
    setActualRange(null);
    setWaterfallData({
      spectrumData: [],
      frequencies: [],
      timeLabels: [],
    });
    pendingFrameRef.current = null;
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }
    openWebRXHistoryRef.current = [];
  }, []);

  const rebuildOpenWebRXWaterfall = useCallback((viewport: OpenWebRXViewport | null) => {
    if (!viewport || openWebRXHistoryRef.current.length === 0) {
      return;
    }

    const nextSpectrumData = openWebRXHistoryRef.current.map(({ frame: historyFrame, values }) =>
      cropSpectrumToViewport(values, historyFrame.frequencyRange, viewport)
    );
    const viewportMin = viewport.centerHz - viewport.spanHz / 2;
    const viewportMax = viewport.centerHz + viewport.spanHz / 2;
    const firstFrame = openWebRXHistoryRef.current[0]?.frame ?? null;
    const frequencies = new Array(firstFrame ? getSpectrumBinCount(firstFrame) : 0)
      .fill(0)
      .map((_, index, array) => viewportMin + (index * (viewportMax - viewportMin)) / Math.max(array.length - 1, 1));

    setWaterfallData({
      spectrumData: nextSpectrumData,
      frequencies,
      timeLabels: openWebRXHistoryRef.current.map(entry => entry.timeLabel),
    });
  }, [getSpectrumBinCount]);

  const performUpdate = useCallback(() => {
    const nextFrame = pendingFrameRef.current;
    if (!nextFrame) return;

    pendingFrameRef.current = null;
    const values = decodeSpectrumData(nextFrame);
    const timeLabel = new Date().toISOString().slice(11, 23);

    setWaterfallData(prev => {
      const nextFrequencies = generateFrequencyAxis(nextFrame);
      const frequenciesChanged = prev.frequencies.length !== nextFrequencies.length
        || prev.frequencies[0] !== nextFrequencies[0]
        || prev.frequencies[prev.frequencies.length - 1] !== nextFrequencies[nextFrequencies.length - 1];

      return {
        spectrumData: [values, ...prev.spectrumData].slice(0, WATERFALL_HISTORY),
        frequencies: frequenciesChanged ? nextFrequencies : prev.frequencies,
        timeLabels: [timeLabel, ...prev.timeLabels].slice(0, WATERFALL_HISTORY),
      };
    });

    setFrame(nextFrame);
  }, [decodeSpectrumData, generateFrequencyAxis]);

  const updateWaterfallData = useCallback((nextFrame: SpectrumFrame) => {
    const now = Date.now();
    pendingFrameRef.current = nextFrame;

    if (now - lastUpdateRef.current >= WATERFALL_UPDATE_INTERVAL) {
      lastUpdateRef.current = now;
      performUpdate();
      return;
    }

    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
    }

    const delay = WATERFALL_UPDATE_INTERVAL - (now - lastUpdateRef.current);
    updateTimerRef.current = setTimeout(() => {
      lastUpdateRef.current = Date.now();
      performUpdate();
    }, delay);
  }, [performUpdate]);

  const updateOpenWebRXWaterfallData = useCallback((nextFrame: SpectrumFrame) => {
    const values = decodeSpectrumData(nextFrame);
    const timeLabel = new Date().toISOString().slice(11, 23);

    const existingIndex = openWebRXHistoryRef.current.findIndex(entry => entry.frame.timestamp === nextFrame.timestamp);
    if (existingIndex >= 0) {
      openWebRXHistoryRef.current[existingIndex] = { frame: nextFrame, values, timeLabel };
    } else {
      openWebRXHistoryRef.current = [{ frame: nextFrame, values, timeLabel }, ...openWebRXHistoryRef.current].slice(0, WATERFALL_HISTORY);
    }

    setFrame(nextFrame);
    if (openWebRXViewport) {
      rebuildOpenWebRXWaterfall(openWebRXViewport);
    }
  }, [decodeSpectrumData, openWebRXViewport, rebuildOpenWebRXWaterfall]);

  useEffect(() => {
    if (!isOpenWebRXSdrSelected || !latestFrame || latestFrame.kind !== OPENWEBRX_SDR_SOURCE) {
      return;
    }

    const fullMin = latestFrame.frequencyRange.min;
    const fullMax = latestFrame.frequencyRange.max;
    setOpenWebRXViewport(prev => {
      const nextViewport = clampOpenWebRXViewport(
        prev ?? {
          centerHz: (fullMin + fullMax) / 2,
          spanHz: fullMax - fullMin,
        },
        fullMin,
        fullMax
      );

      if (prev
        && prev.centerHz === nextViewport.centerHz
        && prev.spanHz === nextViewport.spanHz) {
        return prev;
      }

      return nextViewport;
    });
  }, [isOpenWebRXSdrSelected, latestFrame]);

  useEffect(() => {
    if (!latestFrame || !selectedKind || latestFrame.kind !== selectedKind) {
      return;
    }
    if (selectedKind === OPENWEBRX_SDR_SOURCE) {
      updateOpenWebRXWaterfallData(latestFrame);
      return;
    }
    updateWaterfallData(latestFrame);
  }, [latestFrame, selectedKind, updateOpenWebRXWaterfallData, updateWaterfallData]);

  useEffect(() => {
    if (!isOpenWebRXSdrSelected || !openWebRXViewport || openWebRXHistoryRef.current.length === 0) {
      return;
    }

    rebuildOpenWebRXWaterfall(openWebRXViewport);
  }, [isOpenWebRXSdrSelected, openWebRXViewport, rebuildOpenWebRXWaterfall]);

  useEffect(() => {
    resetWaterfall();
  }, [selectedKind, resetWaterfall]);

  useEffect(() => {
    if (selectedKind !== RADIO_SDR_SOURCE) {
      return;
    }

    setPersistedRangeSettings(prev => ({
      ...prev,
      radioSdr: normalizeManualRangeSettings(prev.radioSdr, DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
    }));
  }, [selectedKind]);

  useEffect(() => {
    if (selectedKind !== OPENWEBRX_SDR_SOURCE) {
      return;
    }

    setPersistedRangeSettings(prev => ({
      ...prev,
      openWebRxSdr: normalizeManualRangeSettings(prev.openWebRxSdr, DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr),
    }));
  }, [selectedKind]);

  const availableSources = capabilities?.sources.filter(source => source.available) ?? [];
  const shouldShowSourceTabs = availableSources.length > 1;
  const sourceTabOrder: SpectrumKind[] = [RADIO_SDR_SOURCE, OPENWEBRX_SDR_SOURCE, AUDIO_SOURCE];
  const visibleSourceTabs = sourceTabOrder.filter(kind => availableSources.some(source => source.kind === kind));
  const voiceOverlayIsInteractive = isVoiceMode
    && isRadioSdrSelected
    && isFixedSpectrumMode;
  const openWebRXDisplayBaseFrequency = radioState.currentRadioFrequency;
  const openWebRXTxFrequencies = React.useMemo(() => {
    if (!isOpenWebRXSdrSelected || !showMarkers || isVoiceMode || openWebRXDisplayBaseFrequency === null) {
      return [];
    }

    return txFrequencies.map(({ frequency, ...rest }) => ({
      ...rest,
      frequency: openWebRXDisplayBaseFrequency + frequency,
    }));
  }, [isOpenWebRXSdrSelected, isVoiceMode, openWebRXDisplayBaseFrequency, showMarkers, txFrequencies]);
  const openWebRXRxFrequencies = React.useMemo(() => {
    if (!isOpenWebRXSdrSelected || !showMarkers || isVoiceMode || openWebRXDisplayBaseFrequency === null) {
      return [];
    }

    return rxFrequencies.map(({ frequency, ...rest }) => ({
      ...rest,
      frequency: openWebRXDisplayBaseFrequency + frequency,
    }));
  }, [isOpenWebRXSdrSelected, isVoiceMode, openWebRXDisplayBaseFrequency, rxFrequencies, showMarkers]);
  const effectiveHoverFrequency = isOpenWebRXSdrSelected && openWebRXDisplayBaseFrequency !== null && hoverFrequency !== null && hoverFrequency !== undefined
    ? openWebRXDisplayBaseFrequency + hoverFrequency
    : hoverFrequency;
  const openWebRXFullRange = latestFrame?.kind === OPENWEBRX_SDR_SOURCE
    ? latestFrame.frequencyRange
    : null;
  const voiceBandOverlay: TxBandOverlay[] = React.useMemo(() => {
    if (!isVoiceMode || !isRadioSdrSelected || !radioViewState?.frequency || !radioViewState.offsetModel || !radioViewState.occupiedBandwidthHz) {
      return [];
    }
    const lineFrequency = radioViewState.frequency;
    const bandwidthHz = radioViewState.occupiedBandwidthHz;
    let rangeStartFrequency = lineFrequency;
    let rangeEndFrequency = lineFrequency;

    switch (radioViewState.offsetModel) {
      case 'upper':
        rangeStartFrequency = lineFrequency;
        rangeEndFrequency = lineFrequency + bandwidthHz;
        break;
      case 'lower':
        rangeStartFrequency = lineFrequency - bandwidthHz;
        rangeEndFrequency = lineFrequency;
        break;
      case 'symmetric':
        rangeStartFrequency = lineFrequency - bandwidthHz / 2;
        rangeEndFrequency = lineFrequency + bandwidthHz / 2;
        break;
    }

    return [{
      id: 'voice-current-tx',
      label: 'TX',
      lineFrequency,
      rangeStartFrequency,
      rangeEndFrequency,
      draggable: voiceOverlayIsInteractive,
    }];
  }, [isRadioSdrSelected, isVoiceMode, radioViewState, voiceOverlayIsInteractive]);

  const handleSpectrumKindChange = useCallback((kind: SpectrumKind) => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    setSelectedKind(kind);
    radioService.subscribeSpectrum(kind);
    setPreferredSpectrumKind(activeProfileId, kind);
  }, [activeProfileId, connection.state.radioService, setSelectedKind]);

  const handleStepSpectrumZoom = useCallback((direction: 'in' | 'out') => {
    connection.state.radioService?.stepSpectrumZoom(direction);
  }, [connection.state.radioService]);

  const handleToggleDigitalSpectrumWindow = useCallback(() => {
    connection.state.radioService?.toggleDigitalSpectrumWindow();
  }, [connection.state.radioService]);

  const updateOpenWebRXViewport = useCallback((updater: (current: OpenWebRXViewport) => OpenWebRXViewport) => {
    if (!openWebRXFullRange) {
      return;
    }

    setOpenWebRXViewport(prev => {
      const baseline = clampOpenWebRXViewport(
        prev ?? {
          centerHz: (openWebRXFullRange.min + openWebRXFullRange.max) / 2,
          spanHz: openWebRXFullRange.max - openWebRXFullRange.min,
        },
        openWebRXFullRange.min,
        openWebRXFullRange.max
      );
      return clampOpenWebRXViewport(
        updater(baseline),
        openWebRXFullRange.min,
        openWebRXFullRange.max
      );
    });
  }, [openWebRXFullRange]);

  const handleOpenWebRXWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!isOpenWebRXSdrSelected || !openWebRXViewport || !openWebRXFullRange) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1)));
    const currentMin = openWebRXViewport.centerHz - openWebRXViewport.spanHz / 2;
    const anchorFrequency = currentMin + relativeX * openWebRXViewport.spanHz;
    const zoomFactor = event.deltaY > 0 ? 1.15 : 1 / 1.15;

    updateOpenWebRXViewport(current => {
      const nextSpan = current.spanHz * zoomFactor;
      const nextCenter = anchorFrequency - relativeX * nextSpan + nextSpan / 2;
      return {
        centerHz: nextCenter,
        spanHz: nextSpan,
      };
    });
  }, [isOpenWebRXSdrSelected, openWebRXFullRange, openWebRXViewport, updateOpenWebRXViewport]);

  const handleOpenWebRXMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!isOpenWebRXSdrSelected || !openWebRXViewport || event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('button,[role="tab"],input,[data-no-openwebrx-pan="true"]')) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    openWebRXPanStateRef.current = {
      startX: event.clientX,
      startCenterHz: openWebRXViewport.centerHz,
      width: rect.width,
    };
  }, [isOpenWebRXSdrSelected, openWebRXViewport]);

  const openWebRXZoomLevels = React.useMemo(() => {
    if (!openWebRXFullRange) {
      return [];
    }

    return buildOpenWebRXZoomLevels(openWebRXFullRange.max - openWebRXFullRange.min);
  }, [openWebRXFullRange]);
  const currentOpenWebRXZoomLevelIndex = React.useMemo(() => {
    if (!openWebRXViewport || openWebRXZoomLevels.length === 0) {
      return -1;
    }

    let bestIndex = 0;
    let bestDistance = Math.abs(openWebRXZoomLevels[0] - openWebRXViewport.spanHz);
    for (let index = 1; index < openWebRXZoomLevels.length; index += 1) {
      const distance = Math.abs(openWebRXZoomLevels[index] - openWebRXViewport.spanHz);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    return bestIndex;
  }, [openWebRXViewport, openWebRXZoomLevels]);
  const shouldShowOpenWebRXZoomControls = isOpenWebRXSdrSelected && openWebRXZoomLevels.length > 0;
  const canOpenWebRXZoomOut = shouldShowOpenWebRXZoomControls && currentOpenWebRXZoomLevelIndex > 0;
  const canOpenWebRXZoomIn = shouldShowOpenWebRXZoomControls
    && currentOpenWebRXZoomLevelIndex >= 0
    && currentOpenWebRXZoomLevelIndex < openWebRXZoomLevels.length - 1;

  const handleStepOpenWebRXZoom = useCallback((direction: 'in' | 'out') => {
    if (!openWebRXViewport || openWebRXZoomLevels.length === 0 || currentOpenWebRXZoomLevelIndex < 0) {
      return;
    }

    const nextIndex = direction === 'in'
      ? Math.min(openWebRXZoomLevels.length - 1, currentOpenWebRXZoomLevelIndex + 1)
      : Math.max(0, currentOpenWebRXZoomLevelIndex - 1);

    if (nextIndex === currentOpenWebRXZoomLevelIndex) {
      return;
    }

    updateOpenWebRXViewport(current => ({
      centerHz: current.centerHz,
      spanHz: openWebRXZoomLevels[nextIndex],
    }));
  }, [currentOpenWebRXZoomLevelIndex, openWebRXViewport, openWebRXZoomLevels, updateOpenWebRXViewport]);

  const isCenterSpectrumMode = isRadioSdrSelected
    && (spectrumDisplayState?.mode === 'center' || spectrumDisplayState?.mode === 'scroll-center');
  const shouldShowZoomControls = isCenterSpectrumMode;
  const shouldShowDigitalSpectrumWindowControl = isRadioSdrSelected
    && Boolean(digitalWindowState?.supported);
  const currentZoomLevelIndex = zoomState?.levels.findIndex(level => level.id === zoomState.currentLevelId) ?? -1;
  const zoomControlsDisabled = !zoomState?.supported || !zoomState.available || !zoomState.currentLevelId || currentZoomLevelIndex < 0;
  const canZoomOut = !zoomControlsDisabled && currentZoomLevelIndex > 0;
  const canZoomIn = !zoomControlsDisabled && currentZoomLevelIndex < (zoomState?.levels.length ?? 0) - 1;

  const renderBottomRightControls = () => {
    if (!shouldShowZoomControls && !shouldShowDigitalSpectrumWindowControl && !shouldShowOpenWebRXZoomControls) {
      return null;
    }

    return (
      <div className="absolute bottom-1 right-1 z-20 flex items-center gap-0.5 rounded-medium bg-black/35 px-0.5 py-0.5 backdrop-blur-sm">
        {shouldShowDigitalSpectrumWindowControl && (
          <Tooltip
            content={
              digitalWindowState?.pending
                ? t('spectrum.digitalWindowPending')
                : digitalWindowState?.active
                  ? t('spectrum.digitalWindowDisable')
                  : t('spectrum.digitalWindowEnable')
            }
            placement="top"
            offset={6}
          >
            <Button
              size="sm"
              variant="light"
              className={`min-w-9 w-9 h-5 px-0 text-[10px] font-semibold ${
                digitalWindowState?.active
                  ? 'bg-primary-500/25 text-white'
                  : digitalWindowState?.pending
                    ? 'bg-white/10 text-white/70'
                    : 'text-white/90'
              } disabled:text-default-500`}
              onPress={handleToggleDigitalSpectrumWindow}
              isDisabled={!digitalWindowState?.canToggle}
            >
              {digitalWindowState?.active
                ? t('spectrum.digitalWindowFixedLabel')
                : t('spectrum.digitalWindowFollowLabel')}
            </Button>
          </Tooltip>
        )}
        {shouldShowZoomControls && (
          <>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="min-w-5 w-5 h-5 px-0 text-white/90 disabled:text-default-500"
              onPress={() => handleStepSpectrumZoom('out')}
              isDisabled={!canZoomOut}
              title={t('spectrum.zoomOut')}
            >
              <MinusIcon className="w-2.5 h-2.5" />
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="min-w-5 w-5 h-5 px-0 text-white/90 disabled:text-default-500"
              onPress={() => handleStepSpectrumZoom('in')}
              isDisabled={!canZoomIn}
              title={t('spectrum.zoomIn')}
            >
              <PlusIcon className="w-2.5 h-2.5" />
            </Button>
          </>
        )}
        {shouldShowOpenWebRXZoomControls && (
          <>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="min-w-5 w-5 h-5 px-0 text-white/90 disabled:text-default-500"
              onPress={() => handleStepOpenWebRXZoom('out')}
              isDisabled={!canOpenWebRXZoomOut}
              title={t('spectrum.zoomOut')}
            >
              <MinusIcon className="w-2.5 h-2.5" />
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="min-w-5 w-5 h-5 px-0 text-white/90 disabled:text-default-500"
              onPress={() => handleStepOpenWebRXZoom('in')}
              isDisabled={!canOpenWebRXZoomIn}
              title={t('spectrum.zoomIn')}
            >
              <PlusIcon className="w-2.5 h-2.5" />
            </Button>
          </>
        )}
      </div>
    );
  };

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const panState = openWebRXPanStateRef.current;
      if (!panState || !isOpenWebRXSdrSelected) {
        return;
      }

      const deltaX = event.clientX - panState.startX;
      updateOpenWebRXViewport(current => ({
        centerHz: panState.startCenterHz - (deltaX / Math.max(panState.width, 1)) * current.spanHz,
        spanHz: current.spanHz,
      }));
    };

    const handleMouseUp = () => {
      openWebRXPanStateRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isOpenWebRXSdrSelected, updateOpenWebRXViewport]);

  if (!frame || waterfallData.spectrumData.length === 0) {
    return (
      <div className={`relative flex items-center justify-center ${className}`} style={{ height }}>
        <div className="text-default-400">{t('spectrum.waiting')}</div>
        {shouldShowSourceTabs && selectedKind && (
          <div className="absolute top-1 left-1 z-20">
            <Tabs
              size="sm"
              selectedKey={selectedKind}
              onSelectionChange={(key) => handleSpectrumKindChange(key as SpectrumKind)}
              classNames={{
                tabList: 'min-h-0 gap-0.5 bg-black/30 p-0.5 backdrop-blur-sm',
                tab: 'min-h-0 h-6 px-2 text-[11px]',
                tabContent: 'text-[11px] leading-none',
              }}
            >
              {visibleSourceTabs.map(kind => (
                <Tab
                  key={kind}
                  title={
                    kind === RADIO_SDR_SOURCE
                      ? t('spectrum.radioSdrSource')
                      : kind === OPENWEBRX_SDR_SOURCE
                        ? t('spectrum.openwebrxSdrSource')
                        : t('spectrum.audioSource')
                  }
                />
              ))}
            </Tabs>
          </div>
        )}
        {renderBottomRightControls()}
        {canPopOut && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            onPress={handlePopOut}
            className="absolute top-1 right-1 min-w-unit-8 w-8 h-8 text-default-600 hover:text-default-900 dark:text-default-400 dark:hover:text-default-100 hover:bg-black/30 dark:hover:bg-white/20 hover:backdrop-blur-sm transition-all"
            title={t('spectrum.popOut')}
          >
            <ArrowsPointingOutIcon className="w-4 h-4" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`relative ${className}`}
      onWheel={isOpenWebRXSdrSelected ? handleOpenWebRXWheel : undefined}
      onMouseDown={isOpenWebRXSdrSelected ? handleOpenWebRXMouseDown : undefined}
    >
      <WebGLWaterfall
        data={waterfallData.spectrumData}
        frequencies={waterfallData.frequencies}
        height={height}
        minDb={currentManualRangeSettings.minDb}
        maxDb={currentManualRangeSettings.maxDb}
        autoRange={!isRadioSdrSelected && !isOpenWebRXSdrSelected && audioRangeSettings.mode === 'auto'}
        autoRangeConfig={audioRangeSettings.auto}
        totalRows={WATERFALL_HISTORY}
        frequencyRangeMode={frequencyRangeMode}
        referenceFrequencyHz={spectrumReferenceFrequency}
        basebandInteractionRange={BASEBAND_INTERACTION_RANGE}
        interactionFrequencyMode={isVoiceMode && isRadioSdrSelected ? 'absolute' : 'baseband'}
        txBandOverlays={voiceBandOverlay}
        rxFrequencies={
          isOpenWebRXSdrSelected
            ? openWebRXRxFrequencies
            : (showMarkers && !isVoiceMode ? rxFrequencies : [])
        }
        txFrequencies={
          isOpenWebRXSdrSelected
            ? openWebRXTxFrequencies
            : (showMarkers && !isVoiceMode ? txFrequencies : [])
        }
        onTxFrequencyChange={showMarkers && !isVoiceMode && !isOpenWebRXSdrSelected ? handleTxFrequencyChange : undefined}
        onTxBandOverlayFrequencyChange={voiceOverlayIsInteractive ? (_id, frequency) => void handleVoiceFrequencyChange(frequency) : undefined}
        onRightClickSetFrequency={
          isOpenWebRXSdrSelected
            ? undefined
            : isVoiceMode && isRadioSdrSelected
            ? (voiceOverlayIsInteractive ? (frequency) => void handleVoiceFrequencyChange(frequency) : undefined)
            : (showMarkers ? handleRightClickSetFrequency : undefined)
        }
        onActualRangeChange={setActualRange}
        hoverFrequency={effectiveHoverFrequency}
        isTransmitting={isTransmitting}
        className="bg-transparent"
      />

      {shouldShowSourceTabs && selectedKind && (
        <div className="absolute top-1 left-1 z-20">
          <Tabs
            size="sm"
            selectedKey={selectedKind}
            onSelectionChange={(key) => handleSpectrumKindChange(key as SpectrumKind)}
            classNames={{
              tabList: 'min-h-0 gap-0.5 bg-black/30 p-0.5 backdrop-blur-sm',
              tab: 'min-h-0 h-6 px-2 text-[11px]',
              tabContent: 'text-[11px] leading-none',
            }}
          >
            {visibleSourceTabs.map(kind => (
              <Tab
                key={kind}
                title={
                  kind === RADIO_SDR_SOURCE
                    ? t('spectrum.radioSdrSource')
                    : kind === OPENWEBRX_SDR_SOURCE
                      ? t('spectrum.openwebrxSdrSource')
                      : t('spectrum.audioSource')
                }
              />
            ))}
          </Tabs>
        </div>
      )}

      {renderBottomRightControls()}

      {canPopOut && (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          onPress={handlePopOut}
          className="absolute top-1 right-9 min-w-unit-8 w-8 h-8 text-default-600 hover:text-default-900 dark:text-default-400 dark:hover:text-default-100 hover:bg-black/30 dark:hover:bg-white/20 hover:backdrop-blur-sm transition-all"
          title={t('spectrum.popOut')}
        >
          <ArrowsPointingOutIcon className="w-4 h-4" />
        </Button>
      )}

      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="absolute top-1 right-1 min-w-unit-8 w-8 h-8 text-default-600 hover:text-default-900 dark:text-default-400 dark:hover:text-default-100 hover:bg-black/30 dark:hover:bg-white/20 hover:backdrop-blur-sm transition-all"
          >
            <Cog6ToothIcon className="w-4 h-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0">
          <div className="w-full">
            <div className="px-4 py-3 text-sm font-semibold border-b border-divider">
              {t('spectrum.rangeSettings')}
            </div>

            <div className="px-4 py-3">
              <div className="space-y-3">
                {!isRadioSdrSelected && !isOpenWebRXSdrSelected && (
                  <Tabs
                    selectedKey={audioRangeSettings.mode}
                    onSelectionChange={(key) => {
                      const nextMode = key as 'auto' | 'manual';
                      updateAudioRangeSettings(current => {
                        if (current.mode === 'auto' && nextMode === 'manual' && actualRange) {
                          return {
                            ...current,
                            mode: 'manual',
                            manual: {
                              minDb: Math.round(actualRange.min),
                              maxDb: Math.round(actualRange.max),
                            },
                          };
                        }

                        return {
                          ...current,
                          mode: nextMode,
                        };
                      });
                    }}
                    fullWidth
                    size="sm"
                    classNames={{
                      base: 'w-full',
                      tabList: 'w-full',
                      cursor: 'w-full',
                      tab: 'w-full',
                    }}
                  >
                    <Tab key="auto" title={t('spectrum.autoMode')} />
                    <Tab key="manual" title={t('spectrum.manualMode')} />
                  </Tabs>
                )}
                {!isRadioSdrSelected && !isOpenWebRXSdrSelected && audioRangeSettings.mode === 'auto' && (
                  <>
                    <Slider
                      label={t('spectrum.updateInterval')}
                      size="sm"
                      step={1}
                      minValue={1}
                      maxValue={20}
                      value={audioRangeSettings.auto.updateInterval}
                      onChange={(value) => {
                        updateAudioRangeSettings(current => ({
                          ...current,
                          auto: {
                            ...current.auto,
                            updateInterval: value as number,
                          },
                        }));
                      }}
                      getValue={(value) => t('spectrum.frames', { count: value as number })}
                    />
                    <Slider
                      label={t('spectrum.minPercentile')}
                      size="sm"
                      step={1}
                      minValue={5}
                      maxValue={50}
                      value={audioRangeSettings.auto.minPercentile}
                      onChange={(value) => {
                        updateAudioRangeSettings(current => ({
                          ...current,
                          auto: {
                            ...current.auto,
                            minPercentile: value as number,
                          },
                        }));
                      }}
                      getValue={(value) => `${value}%`}
                    />
                    <Slider
                      label={t('spectrum.maxPercentile')}
                      size="sm"
                      step={1}
                      minValue={90}
                      maxValue={100}
                      value={audioRangeSettings.auto.maxPercentile}
                      onChange={(value) => {
                        updateAudioRangeSettings(current => ({
                          ...current,
                          auto: {
                            ...current.auto,
                            maxPercentile: value as number,
                          },
                        }));
                      }}
                      getValue={(value) => `${value}%`}
                    />
                    <Slider
                      label={t('spectrum.expansionFactor')}
                      size="sm"
                      step={0.5}
                      minValue={2}
                      maxValue={8}
                      value={audioRangeSettings.auto.rangeExpansionFactor}
                      onChange={(value) => {
                        updateAudioRangeSettings(current => ({
                          ...current,
                          auto: {
                            ...current.auto,
                            rangeExpansionFactor: value as number,
                          },
                        }));
                      }}
                      getValue={(value) => `${(typeof value === 'number' ? value : value[0]).toFixed(1)}x`}
                    />
                  </>
                )}
                {(isRadioSdrSelected || isOpenWebRXSdrSelected || audioRangeSettings.mode === 'manual') && (
                  <>
                <Slider
                  label={t('spectrum.minDb')}
                  size="sm"
                  step={1}
                  minValue={rangeLimits.min}
                  maxValue={Math.min(rangeLimits.max - 1, currentManualRangeSettings.maxDb - 1)}
                  value={currentManualRangeSettings.minDb}
                  onChange={(value) => {
                    const nextValue = Array.isArray(value) ? value[0] : value;
                    updateCurrentRangeSettings(current => ({
                      ...current,
                      minDb: clampRangeValue(nextValue as number, rangeLimits.min, Math.min(rangeLimits.max - 1, current.maxDb - 1)),
                    }));
                  }}
                />
                <Input
                  label={t('spectrum.minDb')}
                  type="number"
                  size="sm"
                  value={currentManualRangeSettings.minDb.toString()}
                  onValueChange={(value) => {
                    const num = parseFloat(value);
                    if (Number.isNaN(num)) {
                      return;
                    }
                    updateCurrentRangeSettings(current => ({
                      ...current,
                      minDb: clampRangeValue(num, rangeLimits.min, Math.min(rangeLimits.max - 1, current.maxDb - 1)),
                    }));
                  }}
                />
                <Slider
                  label={t('spectrum.maxDb')}
                  size="sm"
                  step={1}
                  minValue={Math.max(rangeLimits.min + 1, currentManualRangeSettings.minDb + 1)}
                  maxValue={rangeLimits.max}
                  value={currentManualRangeSettings.maxDb}
                  onChange={(value) => {
                    const nextValue = Array.isArray(value) ? value[0] : value;
                    updateCurrentRangeSettings(current => ({
                      ...current,
                      maxDb: clampRangeValue(nextValue as number, Math.max(rangeLimits.min + 1, current.minDb + 1), rangeLimits.max),
                    }));
                  }}
                />
                <Input
                  label={t('spectrum.maxDb')}
                  type="number"
                  size="sm"
                  value={currentManualRangeSettings.maxDb.toString()}
                  onValueChange={(value) => {
                    const num = parseFloat(value);
                    if (Number.isNaN(num)) {
                      return;
                    }
                    updateCurrentRangeSettings(current => ({
                      ...current,
                      maxDb: clampRangeValue(num, Math.max(rangeLimits.min + 1, current.minDb + 1), rangeLimits.max),
                    }));
                  }}
                />
                <div className="text-xs text-default-400">
                  {isRadioSdrSelected
                    ? t('spectrum.radioSdrSource')
                    : isOpenWebRXSdrSelected
                      ? t('spectrum.openwebrxSdrSource')
                      : t('spectrum.audioSource')}
                </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
