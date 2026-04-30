import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Slider, Tab, Tabs, Tooltip } from '@heroui/react';
import { ArrowsPointingOutIcon, ChevronDownIcon, ChevronUpIcon, Cog6ToothIcon, MinusIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { SpectrumFrame, SpectrumKind } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useConnection, useCurrentOperatorId, useOperators, useProfiles, usePTTState, useRadioModeState, useSpectrum } from '../../../store/radioStore';
import { createLogger } from '../../../utils/logger';
import { setPreferredSpectrumKind } from '../../../utils/spectrumPreferences';
import { useTargetRxFrequencies, type RxFrequency } from '../../../hooks/useTargetRxFrequencies';
import { useTxFrequencies, type TxFrequency } from '../../../hooks/useTxFrequencies';
import { WebGLWaterfall } from './WebGLWaterfall';
import type { AutoRangeConfig, PresetMarker, TxBandOverlay } from './WebGLWaterfall';
import { SpectrumStreamController } from '../../../spectrum/SpectrumStreamController';
import { readSpectrumSubscriptionPaused, setSpectrumSubscriptionPaused } from '../../../utils/spectrumSubscriptionPause';
import { resetOperatorsForOperatingStateChange } from '../../../utils/operatorReset';
import {
  DEFAULT_SPECTRUM_THEME_ID,
  getSpectrumTheme,
  getSpectrumThemePreviewGradient,
  normalizeSpectrumThemeId,
  SPECTRUM_THEME_IDS,
  type SpectrumThemeId,
} from './spectrumThemes';

const logger = createLogger('SpectrumDisplay');

type ElectronWindowHelper = Window & {
  electronAPI?: {
    window: {
      openSpectrumWindow: () => Promise<void>;
    };
  };
};

const WATERFALL_HISTORY_ROWS = 120;
const SPECTRUM_HISTORY_LIMITS = {
  audio: 120,
  'radio-sdr': WATERFALL_HISTORY_ROWS,
  'openwebrx-sdr': 40,
} satisfies Partial<Record<SpectrumKind, number>>;
const SETTINGS_STORAGE_KEY = 'spectrum-range-settings';
const OPENWEBRX_VIEWPORT_STORAGE_KEY = 'openwebrx-spectrum-viewports';
const AUDIO_SOURCE: SpectrumKind = 'audio';
const RADIO_SDR_SOURCE: SpectrumKind = 'radio-sdr';
const OPENWEBRX_SDR_SOURCE: SpectrumKind = 'openwebrx-sdr';
const BASEBAND_INTERACTION_RANGE = { min: 0, max: 3000 };
const COLLAPSED_DIGITAL_HEIGHT = 32;
const COLLAPSED_VOICE_HEIGHT = 24;
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
  topLeftOverlayInset?: {
    top?: number;
    left?: number;
  };
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

interface LegacyAudioRangeSettings {
  manual?: Partial<ManualRangeSettings>;
  auto?: Partial<AutoRangeConfig>;
  mode?: 'auto' | 'manual';
}

interface PersistedRangeSettings {
  themeId: SpectrumThemeId;
  audio: AudioRangeSettings;
  radioSdr: ManualRangeSettings;
  openWebRxSdr: {
    full: ManualRangeSettings;
    detail: ManualRangeSettings;
  };
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

const DEFAULT_OPENWEBRX_DETAIL_RANGE_SETTINGS: ManualRangeSettings = {
  minDb: -35,
  maxDb: 10,
};

const DEFAULT_PERSISTED_RANGE_SETTINGS: PersistedRangeSettings = {
  themeId: DEFAULT_SPECTRUM_THEME_ID,
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
    full: {
      minDb: DEFAULT_OPENWEBRX_RANGE_SETTINGS.minDb,
      maxDb: DEFAULT_OPENWEBRX_RANGE_SETTINGS.maxDb,
    },
    detail: {
      minDb: DEFAULT_OPENWEBRX_DETAIL_RANGE_SETTINGS.minDb,
      maxDb: DEFAULT_OPENWEBRX_DETAIL_RANGE_SETTINGS.maxDb,
    },
  },
};

function snapFrequencyToStep(frequency: number, stepHz: number | null | undefined): number {
  const step = typeof stepHz === 'number' && Number.isFinite(stepHz) && stepHz > 0 ? stepHz : 1;
  return Math.round(frequency / step) * step;
}

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
  settings: Partial<AudioRangeSettings> | LegacyAudioRangeSettings | null | undefined,
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
        themeId: DEFAULT_PERSISTED_RANGE_SETTINGS.themeId,
        audio: cloneAudioRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.audio),
        radioSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
        openWebRxSdr: {
          full: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.full),
          detail: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.detail),
        },
      };
  }

  try {
    const parsed = JSON.parse(saved) as
      | Partial<PersistedRangeSettings>
      | LegacyAudioRangeSettings;

    if (typeof parsed === 'object' && parsed !== null && ('audio' in parsed || 'radioSdr' in parsed)) {
      return {
        themeId: normalizeSpectrumThemeId((parsed as Partial<PersistedRangeSettings>).themeId),
        audio: normalizeAudioRangeSettings(
          (parsed as Partial<PersistedRangeSettings>).audio,
          DEFAULT_PERSISTED_RANGE_SETTINGS.audio
        ),
        radioSdr: normalizeManualRangeSettings(
          (parsed as Partial<PersistedRangeSettings>).radioSdr,
          DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr
        ),
        openWebRxSdr: (() => {
          const rawOpenWebRX = (parsed as Partial<PersistedRangeSettings>).openWebRxSdr;
          if (
            rawOpenWebRX
            && typeof rawOpenWebRX === 'object'
            && ('full' in rawOpenWebRX || 'detail' in rawOpenWebRX)
          ) {
            return {
              full: normalizeManualRangeSettings(
                (rawOpenWebRX as { full?: Partial<ManualRangeSettings> }).full,
                DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.full
              ),
              detail: normalizeManualRangeSettings(
                (rawOpenWebRX as { detail?: Partial<ManualRangeSettings> }).detail,
                DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.detail
              ),
            };
          }

          return {
            full: normalizeManualRangeSettings(
              rawOpenWebRX as Partial<ManualRangeSettings> | null | undefined,
              DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.full
            ),
            detail: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.detail),
          };
        })(),
      };
    }

    return {
      themeId: DEFAULT_PERSISTED_RANGE_SETTINGS.themeId,
      audio: normalizeAudioRangeSettings(
        parsed as LegacyAudioRangeSettings,
        DEFAULT_PERSISTED_RANGE_SETTINGS.audio
      ),
      radioSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
      openWebRxSdr: {
        full: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.full),
        detail: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.detail),
      },
    };
  } catch (error) {
    logger.error('Failed to parse saved settings', error);
    return {
      themeId: DEFAULT_PERSISTED_RANGE_SETTINGS.themeId,
      audio: cloneAudioRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.audio),
      radioSdr: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
      openWebRxSdr: {
        full: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.full),
        detail: cloneManualRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.detail),
      },
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

export function clampCollapsedSpectrumFrequency(frequency: number): number {
  return Math.max(
    BASEBAND_INTERACTION_RANGE.min,
    Math.min(BASEBAND_INTERACTION_RANGE.max, frequency)
  );
}

export function getCollapsedSpectrumPosition(frequency: number): number {
  const span = BASEBAND_INTERACTION_RANGE.max - BASEBAND_INTERACTION_RANGE.min;
  if (span <= 0) {
    return 0;
  }

  return ((clampCollapsedSpectrumFrequency(frequency) - BASEBAND_INTERACTION_RANGE.min) / span) * 100;
}

interface SpectrumMarkerResolutionInput {
  isOpenWebRXSdrSelected: boolean;
  isOpenWebRXDetailMode: boolean;
  showMarkers: boolean;
  showRxMarkers: boolean;
  showTxMarkers: boolean;
  isVoiceMode: boolean;
  rxFrequencies: RxFrequency[];
  txFrequencies: TxFrequency[];
}

export function resolveSpectrumMarkerFrequencies({
  isOpenWebRXSdrSelected,
  isOpenWebRXDetailMode,
  showMarkers,
  showRxMarkers,
  showTxMarkers,
  isVoiceMode,
  rxFrequencies,
  txFrequencies,
}: SpectrumMarkerResolutionInput): { rxFrequencies: RxFrequency[]; txFrequencies: TxFrequency[] } {
  if (!showMarkers || isVoiceMode) {
    return { rxFrequencies: [], txFrequencies: [] };
  }

  if (isOpenWebRXSdrSelected && !isOpenWebRXDetailMode) {
    return { rxFrequencies: [], txFrequencies: [] };
  }

  return {
    rxFrequencies: showRxMarkers ? rxFrequencies : [],
    txFrequencies: showTxMarkers ? txFrequencies : [],
  };
}

export function resolveCollapsedSpectrumMarkerFrequencies({
  showMarkers,
  isVoiceMode,
  rxFrequencies,
  txFrequencies,
}: Pick<SpectrumMarkerResolutionInput, 'showMarkers' | 'isVoiceMode' | 'rxFrequencies' | 'txFrequencies'>): {
  rxFrequencies: RxFrequency[];
  txFrequencies: TxFrequency[];
} {
  if (!showMarkers || isVoiceMode) {
    return { rxFrequencies: [], txFrequencies: [] };
  }

  return { rxFrequencies, txFrequencies };
}

interface CollapsedSpectrumBarProps {
  className?: string;
  controller: SpectrumStreamController;
  height: number;
  isVoiceMode: boolean;
  hoverFrequency?: number | null;
  rxFrequencies: RxFrequency[];
  txFrequencies: TxFrequency[];
  onTxFrequencyChange?: (operatorId: string, frequency: number) => void;
  onRestore: () => void;
}

const CollapsedSpectrumBar: React.FC<CollapsedSpectrumBarProps> = ({
  className = '',
  controller,
  height,
  isVoiceMode,
  hoverFrequency,
  rxFrequencies,
  txFrequencies,
  onTxFrequencyChange,
  onRestore,
}) => {
  return (
    <div
      className={`relative overflow-hidden bg-default-50 dark:bg-default-100/50 ${className}`}
      style={{ height }}
    >
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.08)_1px,transparent_1px),linear-gradient(180deg,rgba(0,0,0,0.06)_1px,transparent_1px)] bg-[length:12.5%_100%,100%_50%] opacity-80 dark:bg-[linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.05)_1px,transparent_1px)]" />
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-primary-500/45 to-transparent dark:via-primary-400/35" />
      <div className="absolute left-2 top-1/2 z-10 -translate-y-1/2 select-none text-[11px] font-medium text-default-400/60 dark:text-default-500/60">频谱已收起</div>
      {!isVoiceMode && (
        <WebGLWaterfall
          controller={controller}
          markerOnly
          markerAxis={{
            minHz: BASEBAND_INTERACTION_RANGE.min,
            maxHz: BASEBAND_INTERACTION_RANGE.max + 15,
            binCount: BASEBAND_INTERACTION_RANGE.max - BASEBAND_INTERACTION_RANGE.min + 15,
          }}
          height={height}
          rxFrequencies={rxFrequencies}
          txFrequencies={txFrequencies}
          frequencyRangeMode="baseband"
          basebandInteractionRange={BASEBAND_INTERACTION_RANGE}
          onTxFrequencyChange={onTxFrequencyChange}
          hoverFrequency={hoverFrequency}
          className="absolute inset-0 bg-transparent"
        />
      )}
      <Button
        isIconOnly
        size="sm"
        variant="light"
        onPress={onRestore}
        className="absolute right-1 top-1/2 z-20 h-6 min-w-6 w-6 -translate-y-1/2 px-0 text-default-500 hover:bg-black/25 hover:text-default-900 dark:text-default-300 dark:hover:bg-white/15 dark:hover:text-default-50"
        aria-label="Restore spectrum"
      >
        <ChevronUpIcon className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
};

export const SpectrumDisplay: React.FC<SpectrumDisplayProps> = ({
  className = '',
  height = 200,
  hoverFrequency,
  showPopOut = true,
  onPopOutChange,
  showMarkers = true,
  topLeftOverlayInset,
}) => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const { operators } = useOperators();
  const { activeProfileId } = useProfiles();
  const { currentRadioMode, currentRadioFrequency, engineMode } = useRadioModeState();
  const { pttStatus } = usePTTState();
  const { capabilities, selectedKind, sessionState, setSelectedKind, setSubscribedKind } = useSpectrum();
  const controllerRef = useRef<SpectrumStreamController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new SpectrumStreamController(SPECTRUM_HISTORY_LIMITS);
  }
  const streamController = controllerRef.current;
  const streamStatus = useSyncExternalStore(
    streamController.subscribeStatus,
    streamController.getStatusSnapshot,
    streamController.getStatusSnapshot
  );
  const radioSdrFullRange = streamController.getFullRange(RADIO_SDR_SOURCE);
  const openWebRXStreamRange = streamController.getFullRange(OPENWEBRX_SDR_SOURCE);
  const isTransmitting = pttStatus.isTransmitting;
  const [actualRange, setActualRange] = useState<{ min: number; max: number } | null>(null);
  const [persistedRangeSettings, setPersistedRangeSettings] = useState<PersistedRangeSettings>(() => loadPersistedRangeSettings());
  const [openWebRXViewport, setOpenWebRXViewport] = useState<OpenWebRXViewport | null>(() => readOpenWebRXViewport(activeProfileId));
  const [isCollapsed, setIsCollapsed] = useState(() => readSpectrumSubscriptionPaused());
  const openWebRXPanStateRef = useRef<{ startX: number; startCenterHz: number; width: number } | null>(null);

  const isElectron = typeof window !== 'undefined' && (window as ElectronWindowHelper).electronAPI !== undefined;
  const resetOperatorsAfterOperatingStateChange = useCallback(() => {
    resetOperatorsForOperatingStateChange({
      operators,
      radioService: connection.state.radioService,
    });
  }, [connection.state.radioService, operators]);
  const canPopOut = showPopOut && isElectron;
  const rxFrequencies = useTargetRxFrequencies();
  const txFrequencies = useTxFrequencies();
  const { currentOperatorId } = useCurrentOperatorId();
  const effectiveSelectedKind = selectedKind ?? capabilities?.defaultKind ?? AUDIO_SOURCE;
  const isRadioSdrSelected = effectiveSelectedKind === RADIO_SDR_SOURCE;
  const isOpenWebRXSdrSelected = effectiveSelectedKind === OPENWEBRX_SDR_SOURCE;
  const isVoiceMode = engineMode === 'voice';
  const sourceMode = sessionState?.sourceMode ?? 'unknown';
  const isFixedSpectrumMode = sourceMode === 'fixed' || sourceMode === 'scroll-fixed';
  const isOpenWebRXDetailMode = isOpenWebRXSdrSelected && sourceMode === 'detail';
  const canOpenWebRXLocalViewportZoom = Boolean(sessionState?.interaction.canLocalViewportZoom);
  const canOpenWebRXLocalViewportPan = Boolean(sessionState?.interaction.canLocalViewportPan);
  const canDragTxMarker = Boolean(sessionState?.interaction.canDragTx);
  const canRightClickSetFrequency = Boolean(sessionState?.interaction.canRightClickSetFrequency);
  const canDoubleClickSetFrequency = Boolean(sessionState?.interaction.canDoubleClickSetFrequency);
  const canDragFrequency = Boolean(sessionState?.interaction.canDragFrequency);
  const frequencyGestureTarget = sessionState?.interaction.frequencyGestureTarget ?? null;
  const frequencyGestureStepHz = sessionState?.interaction.frequencyStepHz ?? null;
  const showTxMarkers = Boolean(sessionState?.interaction.showTxMarkers);
  const showRxMarkers = Boolean(sessionState?.interaction.showRxMarkers);
  const frequencyRangeMode = sessionState?.frequencyRangeMode ?? (
    isOpenWebRXSdrSelected
      ? 'absolute-windowed'
      : !isRadioSdrSelected
        ? 'baseband'
        : isFixedSpectrumMode
          ? 'absolute-fixed'
          : 'absolute-center'
  );
  const spectrumReferenceFrequency = isRadioSdrSelected
    ? (sessionState?.currentRadioFrequency ?? currentRadioFrequency ?? null)
    : null;
  const currentManualRangeSettings = isOpenWebRXSdrSelected
    ? (isOpenWebRXDetailMode
        ? persistedRangeSettings.openWebRxSdr.detail
        : persistedRangeSettings.openWebRxSdr.full)
    : isRadioSdrSelected
      ? persistedRangeSettings.radioSdr
      : persistedRangeSettings.audio.manual;
  const selectedSpectrumThemeId = persistedRangeSettings.themeId;
  const audioRangeSettings = persistedRangeSettings.audio;
  const rangeLimits = isOpenWebRXSdrSelected
    ? OPENWEBRX_RANGE_LIMITS
    : isRadioSdrSelected
      ? RADIO_SDR_RANGE_LIMITS
      : AUDIO_RANGE_LIMITS;
  const topLeftOverlayStyle = topLeftOverlayInset
    ? {
        top: topLeftOverlayInset.top ?? 4,
        left: topLeftOverlayInset.left ?? 4,
      }
    : undefined;

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
          openWebRxSdr: {
            ...prev.openWebRxSdr,
            [isOpenWebRXDetailMode ? 'detail' : 'full']: updater(
              isOpenWebRXDetailMode ? prev.openWebRxSdr.detail : prev.openWebRxSdr.full
            ),
          },
        };
      }

      return {
        ...prev,
        audio: {
          ...prev.audio,
          manual: updater(prev.audio.manual),
        },
      };
    });
  }, [isOpenWebRXDetailMode, isOpenWebRXSdrSelected, isRadioSdrSelected]);

  const updateAudioRangeSettings = useCallback((updater: (current: AudioRangeSettings) => AudioRangeSettings) => {
    setPersistedRangeSettings(prev => ({
      ...prev,
      audio: updater(prev.audio),
    }));
  }, []);

  const handleSpectrumThemeChange = useCallback((themeId: SpectrumThemeId) => {
    setPersistedRangeSettings(prev => ({
      ...prev,
      themeId,
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

  const displayTxFrequencyChange = showMarkers && canDragTxMarker && !isVoiceMode
    ? handleTxFrequencyChange
    : undefined;
  const collapsedTxFrequencyChange = showMarkers && !isVoiceMode
    ? handleTxFrequencyChange
    : undefined;

  const handleRightClickSetFrequency = useCallback((frequency: number) => {
    if (currentOperatorId) {
      handleTxFrequencyChange(currentOperatorId, frequency);
    }
  }, [currentOperatorId, handleTxFrequencyChange]);

  const handleVoiceFrequencyChange = useCallback(async (frequency: number) => {
    if (!connection.state.isConnected) {
      return;
    }

    const snappedFrequency = snapFrequencyToStep(frequency, frequencyGestureStepHz);
    const nextRadioMode = sessionState?.voice.radioMode ?? currentRadioMode ?? 'USB';

    try {
      const response = await api.setRadioFrequency({
        frequency: Math.round(snappedFrequency),
        mode: 'VOICE',
        band: 'Custom',
        description: `${(snappedFrequency / 1_000_000).toFixed(3)} MHz`,
        radioMode: nextRadioMode,
      });
      if (response.success) {
        resetOperatorsAfterOperatingStateChange();
      }
    } catch (error) {
      logger.error('Failed to set voice frequency from SDR overlay', error);
    }
  }, [connection.state.isConnected, currentRadioMode, frequencyGestureStepHz, resetOperatorsAfterOperatingStateChange, sessionState?.voice.radioMode]);

  const handleRadioFrequencyGesture = useCallback((frequency: number) => {
    void handleVoiceFrequencyChange(frequency);
  }, [handleVoiceFrequencyChange]);

  const handleCollapseSpectrum = useCallback(() => {
    const radioService = connection.state.radioService;
    setSpectrumSubscriptionPaused(true);
    setIsCollapsed(true);
    setSubscribedKind(null);
    streamController.reset();
    radioService?.subscribeSpectrum(null);
  }, [connection.state.radioService, setSubscribedKind, streamController]);

  const handleRestoreSpectrum = useCallback(() => {
    const radioService = connection.state.radioService;
    const kind = selectedKind ?? capabilities?.defaultKind ?? AUDIO_SOURCE;
    setSpectrumSubscriptionPaused(false);
    setIsCollapsed(false);
    setSubscribedKind(kind);
    radioService?.subscribeSpectrum(kind);
  }, [capabilities?.defaultKind, connection.state.radioService, selectedKind, setSubscribedKind]);

  useEffect(() => {
    return () => {
      streamController.destroy();
    };
  }, [streamController]);

  useEffect(() => {
    if (!isCollapsed) {
      return;
    }

    setSubscribedKind(null);
    streamController.reset();
    connection.state.radioService?.subscribeSpectrum(null);
  }, [connection.state.radioService, isCollapsed, setSubscribedKind, streamController]);

  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) {
      streamController.reset();
      return;
    }

    const wsClient = radioService.wsClientInstance;
    const handleSpectrumFrame = (data: unknown) => {
      if (isCollapsed) {
        return;
      }
      streamController.pushFrame(data as SpectrumFrame);
    };

    wsClient.onWSEvent('spectrumFrame', handleSpectrumFrame);
    return () => {
      wsClient.offWSEvent('spectrumFrame', handleSpectrumFrame);
    };
  }, [connection.state.radioService, isCollapsed, streamController]);

  useEffect(() => {
    streamController.updateContext({
      selectedKind: effectiveSelectedKind,
      radioSdrDisplayRange: isRadioSdrSelected ? (sessionState?.displayRange ?? radioSdrFullRange ?? null) : null,
      openWebRXViewport: isOpenWebRXSdrSelected && !isOpenWebRXDetailMode ? openWebRXViewport : null,
      isOpenWebRXDetailMode,
    });
  }, [
    effectiveSelectedKind,
    isOpenWebRXDetailMode,
    isOpenWebRXSdrSelected,
    isRadioSdrSelected,
    openWebRXViewport,
    radioSdrFullRange,
    sessionState?.displayRange,
    streamController,
  ]);

  useEffect(() => {
    setActualRange(null);
    streamController.reset();
  }, [activeProfileId, streamController]);

  useEffect(() => {
    const fullRange = isOpenWebRXSdrSelected ? (streamStatus.fullRange ?? openWebRXStreamRange) : null;
    if (!isOpenWebRXSdrSelected || isOpenWebRXDetailMode || !fullRange) {
      return;
    }

    const fullMin = fullRange.min;
    const fullMax = fullRange.max;
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
  }, [isOpenWebRXDetailMode, isOpenWebRXSdrSelected, openWebRXStreamRange, streamStatus.fullRange]);

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
      openWebRxSdr: {
        full: normalizeManualRangeSettings(prev.openWebRxSdr.full, DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.full),
        detail: normalizeManualRangeSettings(prev.openWebRxSdr.detail, DEFAULT_PERSISTED_RANGE_SETTINGS.openWebRxSdr.detail),
      },
    }));
  }, [selectedKind]);

  const availableSources = capabilities?.sources.filter(source => source.available) ?? [];
  const shouldShowSourceTabs = availableSources.length > 1;
  const sourceTabOrder: SpectrumKind[] = [OPENWEBRX_SDR_SOURCE, RADIO_SDR_SOURCE, AUDIO_SOURCE];
  const visibleSourceTabs = sourceTabOrder.filter(kind => availableSources.some(source => source.kind === kind));
  const voiceOverlayIsInteractive = Boolean(sessionState?.interaction.canDragVoiceOverlay);
  const displaySpectrumMarkers = React.useMemo(() => resolveSpectrumMarkerFrequencies({
    isOpenWebRXSdrSelected,
    isOpenWebRXDetailMode,
    showMarkers,
    showRxMarkers,
    showTxMarkers,
    isVoiceMode,
    rxFrequencies,
    txFrequencies,
  }), [
    isOpenWebRXDetailMode,
    isOpenWebRXSdrSelected,
    isVoiceMode,
    rxFrequencies,
    showMarkers,
    showRxMarkers,
    showTxMarkers,
    txFrequencies,
  ]);
  const collapsedSpectrumMarkers = React.useMemo(() => resolveCollapsedSpectrumMarkerFrequencies({
    showMarkers,
    isVoiceMode,
    rxFrequencies,
    txFrequencies,
  }), [
    isVoiceMode,
    rxFrequencies,
    showMarkers,
    txFrequencies,
  ]);
  const effectiveHoverFrequency = hoverFrequency;
  const openWebRXFullRange = isOpenWebRXSdrSelected ? (streamStatus.fullRange ?? openWebRXStreamRange) : null;
  const voiceBandOverlay: TxBandOverlay[] = React.useMemo(() => {
    if (
      !isVoiceMode
      || !isRadioSdrSelected
      || !sessionState?.currentRadioFrequency
      || !sessionState.voice.offsetModel
      || !sessionState.voice.occupiedBandwidthHz
    ) {
      return [];
    }
    const lineFrequency = sessionState.currentRadioFrequency;
    const bandwidthHz = sessionState.voice.occupiedBandwidthHz;
    let rangeStartFrequency = lineFrequency;
    let rangeEndFrequency = lineFrequency;

    switch (sessionState.voice.offsetModel) {
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
  }, [isRadioSdrSelected, isVoiceMode, sessionState, voiceOverlayIsInteractive]);
  const presetMarkers: PresetMarker[] = React.useMemo(() => {
    if (!isVoiceMode) {
      return [];
    }

    return (sessionState?.interaction.presetMarkers ?? []).map((marker) => ({
      id: marker.id,
      frequency: marker.frequency,
      label: marker.label,
      description: marker.description,
      clickable: marker.clickable,
    }));
  }, [isVoiceMode, sessionState?.interaction.presetMarkers]);

  const handleSpectrumKindChange = useCallback((kind: SpectrumKind) => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    setSelectedKind(kind);
    if (!isCollapsed) {
      radioService.subscribeSpectrum(kind);
    } else {
      setSubscribedKind(null);
    }
    setPreferredSpectrumKind(activeProfileId, kind);
  }, [activeProfileId, connection.state.radioService, isCollapsed, setSelectedKind, setSubscribedKind]);

  const handleInvokeSpectrumControl = useCallback((id: string, action: 'in' | 'out' | 'toggle') => {
    connection.state.radioService?.invokeSpectrumControl(id, action);
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
    if (!isOpenWebRXSdrSelected || !canOpenWebRXLocalViewportZoom || !openWebRXViewport || !openWebRXFullRange) {
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
  }, [canOpenWebRXLocalViewportZoom, isOpenWebRXSdrSelected, openWebRXFullRange, openWebRXViewport, updateOpenWebRXViewport]);

  const handleOpenWebRXMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!isOpenWebRXSdrSelected || !canOpenWebRXLocalViewportPan || !openWebRXViewport || event.button !== 0) {
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
  }, [canOpenWebRXLocalViewportPan, isOpenWebRXSdrSelected, openWebRXViewport]);

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
  const shouldShowOpenWebRXZoomControls = isOpenWebRXSdrSelected && canOpenWebRXLocalViewportZoom && openWebRXZoomLevels.length > 0;
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

  const controls = sessionState?.controls ?? [];
  const spectrumZoomOutControl = controls.find(control => control.id === 'zoom-step' && control.action === 'out' && control.visible);
  const spectrumZoomInControl = controls.find(control => control.id === 'zoom-step' && control.action === 'in' && control.visible);
  const digitalWindowControl = controls.find(control => control.id === 'digital-window-toggle' && control.visible);
  const openWebRXDetailControl = controls.find(control => control.id === 'openwebrx-detail-toggle' && control.visible);
  const viewportZoomOutControl = controls.find(control => control.id === 'viewport-zoom' && control.action === 'out' && control.visible);
  const viewportZoomInControl = controls.find(control => control.id === 'viewport-zoom' && control.action === 'in' && control.visible);
  const shouldShowZoomControls = Boolean(spectrumZoomOutControl || spectrumZoomInControl);
  const shouldShowDigitalSpectrumWindowControl = Boolean(digitalWindowControl);
  const shouldShowOpenWebRXDetailControl = Boolean(openWebRXDetailControl);
  const effectiveShowOpenWebRXZoomControls = shouldShowOpenWebRXZoomControls
    && Boolean(viewportZoomOutControl || viewportZoomInControl);

  const renderBottomRightControls = () => {
    if (
      !shouldShowZoomControls
      && !shouldShowDigitalSpectrumWindowControl
      && !shouldShowOpenWebRXDetailControl
      && !effectiveShowOpenWebRXZoomControls
    ) {
      return null;
    }

    return (
      <div className="absolute bottom-1 right-1 z-20 flex items-center gap-0.5 rounded-medium bg-black/35 px-0.5 py-0.5 backdrop-blur-sm">
        {shouldShowDigitalSpectrumWindowControl && (
          <Tooltip
            content={
              digitalWindowControl?.pending
                ? t('spectrum.digitalWindowPending')
                : digitalWindowControl?.active
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
                digitalWindowControl?.active
                  ? 'bg-primary-500/25 text-white'
                  : digitalWindowControl?.pending
                    ? 'bg-white/10 text-white/70'
                    : 'text-white/90'
              } disabled:text-default-500`}
              onPress={() => handleInvokeSpectrumControl('digital-window-toggle', 'toggle')}
              isDisabled={!digitalWindowControl?.enabled}
            >
              {digitalWindowControl?.active
                ? t('spectrum.digitalWindowFixedLabel')
                : t('spectrum.digitalWindowFollowLabel')}
            </Button>
          </Tooltip>
        )}
        {shouldShowOpenWebRXDetailControl && (
          <Tooltip
            content={
              openWebRXDetailControl?.active
                ? t('spectrum.openwebrxDetailDisable')
                : t('spectrum.openwebrxDetailEnable')
            }
            placement="top"
            offset={6}
          >
            <Button
              size="sm"
              variant="light"
              className={`min-w-10 w-10 h-5 px-0 text-[10px] font-semibold ${
                openWebRXDetailControl?.active
                  ? 'bg-primary-500/25 text-white'
                  : 'text-white/90'
              } disabled:text-default-500`}
              onPress={() => handleInvokeSpectrumControl('openwebrx-detail-toggle', 'toggle')}
              isDisabled={!openWebRXDetailControl?.enabled}
            >
              {openWebRXDetailControl?.active
                ? t('spectrum.openwebrxDetailActiveLabel')
                : t('spectrum.openwebrxDetailInactiveLabel')}
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
              onPress={() => handleInvokeSpectrumControl('zoom-step', 'out')}
              isDisabled={!spectrumZoomOutControl?.enabled}
              title={t('spectrum.zoomOut')}
            >
              <MinusIcon className="w-2.5 h-2.5" />
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="min-w-5 w-5 h-5 px-0 text-white/90 disabled:text-default-500"
              onPress={() => handleInvokeSpectrumControl('zoom-step', 'in')}
              isDisabled={!spectrumZoomInControl?.enabled}
              title={t('spectrum.zoomIn')}
            >
              <PlusIcon className="w-2.5 h-2.5" />
            </Button>
          </>
        )}
        {effectiveShowOpenWebRXZoomControls && (
          <>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="min-w-5 w-5 h-5 px-0 text-white/90 disabled:text-default-500"
              onPress={() => handleStepOpenWebRXZoom('out')}
              isDisabled={!viewportZoomOutControl?.enabled || !canOpenWebRXZoomOut}
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
              isDisabled={!viewportZoomInControl?.enabled || !canOpenWebRXZoomIn}
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

  const renderCollapseButton = (rightClassName = 'right-1') => (
    <Button
      isIconOnly
      size="sm"
      variant="light"
      onPress={handleCollapseSpectrum}
      className={`absolute top-1 ${rightClassName} z-30 h-6 min-w-6 w-6 px-0 text-default-600 hover:bg-black/30 hover:text-default-900 dark:text-default-300 dark:hover:bg-white/15 dark:hover:text-default-50`}
      aria-label="Collapse spectrum"
    >
      <ChevronDownIcon className="h-3.5 w-3.5" />
    </Button>
  );

  if (isCollapsed) {
    return (
      <CollapsedSpectrumBar
        className={className}
        controller={streamController}
        height={isVoiceMode ? COLLAPSED_VOICE_HEIGHT : COLLAPSED_DIGITAL_HEIGHT}
        isVoiceMode={isVoiceMode}
        hoverFrequency={effectiveHoverFrequency}
        rxFrequencies={collapsedSpectrumMarkers.rxFrequencies}
        txFrequencies={collapsedSpectrumMarkers.txFrequencies}
        onTxFrequencyChange={collapsedTxFrequencyChange}
        onRestore={handleRestoreSpectrum}
      />
    );
  }

  if (!streamStatus.hasData) {
    return (
      <div className={`relative flex items-center justify-center ${className}`} style={{ height }}>
        <div className="text-default-400">{t('spectrum.waiting')}</div>
        {shouldShowSourceTabs && selectedKind && (
          <div className="absolute top-1 left-1 z-20" style={topLeftOverlayStyle}>
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
        {renderCollapseButton()}
        {canPopOut && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            onPress={handlePopOut}
            className="absolute top-1 right-8 z-30 h-6 min-w-6 w-6 px-0 text-default-600 hover:bg-black/30 hover:text-default-900 dark:text-default-300 dark:hover:bg-white/15 dark:hover:text-default-50"
            aria-label={t('spectrum.popOut')}
          >
            <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`relative ${className}`}
      onWheel={isOpenWebRXSdrSelected && canOpenWebRXLocalViewportZoom ? handleOpenWebRXWheel : undefined}
      onMouseDown={isOpenWebRXSdrSelected && canOpenWebRXLocalViewportPan ? handleOpenWebRXMouseDown : undefined}
    >
      <WebGLWaterfall
        controller={streamController}
        height={height}
        minDb={currentManualRangeSettings.minDb}
        maxDb={currentManualRangeSettings.maxDb}
        autoRange={!isRadioSdrSelected && !isOpenWebRXSdrSelected && audioRangeSettings.mode === 'auto'}
        autoRangeConfig={audioRangeSettings.auto}
        themeId={selectedSpectrumThemeId}
        totalRows={WATERFALL_HISTORY_ROWS}
        frequencyRangeMode={frequencyRangeMode}
        referenceFrequencyHz={spectrumReferenceFrequency}
        basebandInteractionRange={BASEBAND_INTERACTION_RANGE}
        interactionFrequencyMode={
          frequencyGestureTarget === 'radio-frequency'
            ? 'absolute'
            : 'baseband'
        }
        interactionFrequencyStepHz={frequencyGestureStepHz}
        txBandOverlays={voiceBandOverlay}
        presetMarkers={presetMarkers}
        rxFrequencies={displaySpectrumMarkers.rxFrequencies}
        txFrequencies={displaySpectrumMarkers.txFrequencies}
        onTxFrequencyChange={displayTxFrequencyChange}
        onTxBandOverlayFrequencyChange={voiceOverlayIsInteractive ? (_id, frequency) => void handleVoiceFrequencyChange(frequency) : undefined}
        onPresetMarkerClick={presetMarkers.length > 0 ? handleRadioFrequencyGesture : undefined}
        // Voice-mode whole-spectrum drag tuning is intentionally disabled.
        // The follow/center viewport recenters during tuning, which currently makes drag interaction feel unstable.
        onDragFrequencyChange={
          frequencyGestureTarget === 'radio-frequency' && canDragFrequency
            ? handleRadioFrequencyGesture
            : undefined
        }
        onDoubleClickSetFrequency={
          frequencyGestureTarget === 'radio-frequency' && canDoubleClickSetFrequency
            ? handleRadioFrequencyGesture
            : undefined
        }
        onRightClickSetFrequency={
          isOpenWebRXSdrSelected
            ? (isOpenWebRXDetailMode ? handleRightClickSetFrequency : undefined)
            : frequencyGestureTarget === 'radio-frequency'
            ? (canRightClickSetFrequency ? handleRadioFrequencyGesture : undefined)
            : (showMarkers && canRightClickSetFrequency ? handleRightClickSetFrequency : undefined)
        }
        onActualRangeChange={setActualRange}
        hoverFrequency={effectiveHoverFrequency}
        isTransmitting={isTransmitting}
        className="bg-transparent"
      />

      {shouldShowSourceTabs && selectedKind && (
        <div className="absolute top-1 left-1 z-20" style={topLeftOverlayStyle}>
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

      {renderCollapseButton()}

      {canPopOut && (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          onPress={handlePopOut}
          className="absolute top-1 right-[3.75rem] z-30 h-6 min-w-6 w-6 px-0 text-default-600 hover:bg-black/30 hover:text-default-900 dark:text-default-300 dark:hover:bg-white/15 dark:hover:text-default-50"
          aria-label={t('spectrum.popOut')}
        >
          <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
        </Button>
      )}

      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="absolute top-1 right-8 z-30 h-6 min-w-6 w-6 px-0 text-default-600 hover:bg-black/30 hover:text-default-900 dark:text-default-300 dark:hover:bg-white/15 dark:hover:text-default-50"
            aria-label="Spectrum settings"
          >
            <Cog6ToothIcon className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0">
          <div className="w-full">
            <div className="px-4 py-3 text-sm font-semibold border-b border-divider">
              {t('spectrum.rangeSettings')}
            </div>

            <div className="px-4 py-3">
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-default-500">
                    {t('spectrum.themeSettings')}
                  </div>
                  <div className="grid grid-cols-8 gap-1.5">
                    {SPECTRUM_THEME_IDS.map((themeId) => {
                      const theme = getSpectrumTheme(themeId);
                      const label = t(theme.labelKey);
                      const selected = selectedSpectrumThemeId === themeId;
                      return (
                        <Tooltip key={themeId} content={label} delay={250}>
                          <Button
                            aria-label={label}
                            title={label}
                            variant="light"
                            size="sm"
                            className={`relative h-7 min-w-0 overflow-hidden rounded-md p-0 ${
                              selected
                                ? 'ring-2 ring-primary-400 ring-offset-1 ring-offset-content1'
                                : 'ring-1 ring-black/10 dark:ring-white/15'
                            }`}
                            style={{
                              backgroundImage: getSpectrumThemePreviewGradient(themeId, '90deg'),
                            }}
                            onPress={() => handleSpectrumThemeChange(themeId)}
                          />
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
                <div className="h-px bg-divider" />
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
