import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Slider, Switch, Tab, Tabs, Tooltip } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { ArrowsPointingOutIcon, ChevronDownIcon, ChevronUpIcon, Cog6ToothIcon, MinusIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { EngineMode, SpectrumFrame, SpectrumKind, SpectrumSessionVoiceState } from '@tx5dr/contracts';
import { getBandFromFrequency } from '@tx5dr/core';
import { useConnection, useCurrentOperatorId, useOperators, useProfiles, usePTTState, useRadioConnectionState, useRadioModeState, useSpectrum, useSplitState } from '../../../store/radioStore';
import { useAbility, useCan } from '../../../store/authStore';
import { createLogger } from '../../../utils/logger';
import { setPreferredSpectrumKind } from '../../../utils/spectrumPreferences';
import { useTargetRxFrequencies, type RxFrequency } from '../../../hooks/useTargetRxFrequencies';
import { useTxFrequencies, type TxFrequency } from '../../../hooks/useTxFrequencies';
import { WebGLWaterfall } from './WebGLWaterfall';
import type { AutoRangeConfig, FrequencyBandOverlay, FrequencyBandOverlayChange, PresetMarker, TxBandOverlay } from './WebGLWaterfall';
import { SpectrumStreamController } from '../../../spectrum/SpectrumStreamController';
import { readSpectrumSubscriptionPaused, setSpectrumSubscriptionPaused } from '../../../utils/spectrumSubscriptionPause';
import { resetOperatorsForOperatingStateChange } from '../../../utils/operatorReset';
import { canExecuteRadioFrequency, canWriteRadioFrequency } from '../../../utils/radioControl';
import { setRadioFrequencyWithIntent, subscribeRadioFrequencyIntent, type SetRadioFrequencyParams } from '../../../utils/radioFrequencyIntent';
import {
  RADIO_SDR_OPTIMISTIC_DISPLAY_HOLD_TIMEOUT_MS,
  RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE,
  RADIO_SDR_OPTIMISTIC_DISPLAY_PENDING_TIMEOUT_MS,
  chooseRadioSdrOptimisticBaselineFrequencyHz,
  confirmRadioSdrOptimisticDisplayStateWithFrame,
  createRadioSdrOptimisticDisplayPendingState,
  reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency,
  resolveRadioSdrOptimisticDisplayFrequencyHz,
  type RadioSdrOptimisticDisplayState,
} from '../../../utils/radioSdrOptimisticDisplay';
import {
  DEFAULT_SPECTRUM_THEME_ID,
  getSpectrumTheme,
  getSpectrumThemePreviewGradient,
  normalizeSpectrumThemeId,
  SPECTRUM_THEME_IDS,
  type SpectrumThemeId,
} from './spectrumThemes';

const logger = createLogger('SpectrumDisplay');
const SPECTRUM_NO_FRAME_STALE_MS = 10_000;
const SPECTRUM_NO_FRAME_CHECK_MS = 1_000;
const SPECTRUM_NO_FRAME_MAX_RETRIES = 3;

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
const RADIO_SDR_VOICE_DRAG_FREQUENCY_STEP_HZ = 1000;
const RADIO_SDR_CW_DRAG_FREQUENCY_STEP_HZ = 10;
const RADIO_SDR_DRAG_FREQUENCY_COMMIT_INTERVAL_MS = 80;
const RADIO_SDR_DRAG_SERVER_SYNC_RELEASE_HOLD_MS = 1000;

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
  frequencyBandOverlays?: FrequencyBandOverlay[];
  onFrequencyBandOverlayPreviewChange?: (id: string, change: FrequencyBandOverlayChange) => void;
  onFrequencyBandOverlayCommit?: (id: string, change: FrequencyBandOverlayChange) => void;
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
  showCycleMarkers: boolean;
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
  showCycleMarkers: true,
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

export function getRadioSdrDragFrequencyStepHz(engineMode: EngineMode): number | null {
  if (engineMode === 'voice') {
    return RADIO_SDR_VOICE_DRAG_FREQUENCY_STEP_HZ;
  }
  if (engineMode === 'cw') {
    return RADIO_SDR_CW_DRAG_FREQUENCY_STEP_HZ;
  }
  return null;
}

export function buildRadioSdrFrequencyRequest({
  engineMode,
  frequency,
  stepHz,
}: {
  engineMode: EngineMode;
  frequency: number;
  stepHz: number | null | undefined;
}): SetRadioFrequencyParams | null {
  const snappedFrequency = snapFrequencyToStep(frequency, stepHz);
  const roundedFrequency = Math.round(snappedFrequency);
  const description = `${(snappedFrequency / 1_000_000).toFixed(3)} MHz`;

  if (engineMode === 'voice') {
    return {
      frequency: roundedFrequency,
      mode: 'VOICE',
      band: 'Custom',
      description,
    };
  }

  if (engineMode === 'cw') {
    return {
      frequency: roundedFrequency,
      mode: 'CW',
      band: getBandFromFrequency(roundedFrequency),
      description,
    };
  }

  return null;
}

export function canUseRadioSdrFrequencyRequest(
  request: SetRadioFrequencyParams | null,
  canWriteTargetFrequency: (frequency: number) => boolean,
): boolean {
  return request !== null && canWriteTargetFrequency(request.frequency);
}

export function buildRadioSdrTxBandOverlays({
  engineMode,
  isRadioSdrSelected,
  currentRadioFrequency,
  splitEnabled = false,
  splitTxFrequency,
  voice,
  voiceOverlayIsInteractive,
}: {
  engineMode: EngineMode;
  isRadioSdrSelected: boolean;
  currentRadioFrequency: number | null | undefined;
  splitEnabled?: boolean;
  splitTxFrequency?: number | null;
  voice: SpectrumSessionVoiceState | null | undefined;
  voiceOverlayIsInteractive: boolean;
}): TxBandOverlay[] {
  if (!isRadioSdrSelected || typeof currentRadioFrequency !== 'number' || !Number.isFinite(currentRadioFrequency)) {
    return [];
  }

  if (engineMode === 'cw') {
    const overlays: TxBandOverlay[] = [{
      id: splitEnabled ? 'cw-current-rx' : 'cw-current-tx',
      label: splitEnabled ? 'RX' : 'TX',
      lineFrequency: currentRadioFrequency,
      rangeStartFrequency: currentRadioFrequency,
      rangeEndFrequency: currentRadioFrequency,
      draggable: false,
      variant: splitEnabled ? 'rx' : 'tx',
    }];

    if (splitEnabled && typeof splitTxFrequency === 'number' && Number.isFinite(splitTxFrequency)) {
      overlays.push({
        id: 'cw-split-tx',
        label: 'TX',
        lineFrequency: splitTxFrequency,
        rangeStartFrequency: splitTxFrequency,
        rangeEndFrequency: splitTxFrequency,
        draggable: false,
        variant: 'tx',
      });
    }

    return overlays;
  }

  if (engineMode !== 'voice' || !voice?.offsetModel || !voice.occupiedBandwidthHz) {
    return [];
  }

  const buildVoiceOverlay = (
    id: string,
    label: string,
    lineFrequency: number,
    draggable: boolean,
    variant: 'tx' | 'rx',
  ): TxBandOverlay => {
    const bandwidthHz = voice.occupiedBandwidthHz!;
    let rangeStartFrequency = lineFrequency;
    let rangeEndFrequency = lineFrequency;

    switch (voice.offsetModel) {
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

    return {
      id,
      label,
      lineFrequency,
      rangeStartFrequency,
      rangeEndFrequency,
      draggable,
      variant,
    };
  };

  const overlays: TxBandOverlay[] = [
    buildVoiceOverlay(
      splitEnabled ? 'voice-current-rx' : 'voice-current-tx',
      splitEnabled ? 'RX' : 'TX',
      currentRadioFrequency,
      voiceOverlayIsInteractive,
      splitEnabled ? 'rx' : 'tx',
    ),
  ];

  if (splitEnabled && typeof splitTxFrequency === 'number' && Number.isFinite(splitTxFrequency)) {
    overlays.push(buildVoiceOverlay(
      'voice-split-tx',
      'TX',
      splitTxFrequency,
      false,
      'tx',
    ));
  }

  return overlays;
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
        showCycleMarkers: DEFAULT_PERSISTED_RANGE_SETTINGS.showCycleMarkers,
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
        showCycleMarkers: (parsed as Partial<PersistedRangeSettings>).showCycleMarkers !== false,
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
      showCycleMarkers: DEFAULT_PERSISTED_RANGE_SETTINGS.showCycleMarkers,
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
      showCycleMarkers: DEFAULT_PERSISTED_RANGE_SETTINGS.showCycleMarkers,
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
  isCwMode?: boolean;
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
  isCwMode = false,
  rxFrequencies,
  txFrequencies,
}: SpectrumMarkerResolutionInput): { rxFrequencies: RxFrequency[]; txFrequencies: TxFrequency[] } {
  if (!showMarkers || isVoiceMode || isCwMode) {
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
  isCwMode,
  rxFrequencies,
  txFrequencies,
}: Pick<SpectrumMarkerResolutionInput, 'showMarkers' | 'isVoiceMode' | 'isCwMode' | 'rxFrequencies' | 'txFrequencies'>): {
  rxFrequencies: RxFrequency[];
  txFrequencies: TxFrequency[];
} {
  if (!showMarkers || isVoiceMode || isCwMode) {
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
  const { t } = useTranslation('common');

  return (
    <div
      className={`relative overflow-hidden bg-default-50 dark:bg-default-100/50 ${className}`}
      style={{ height }}
    >
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.08)_1px,transparent_1px),linear-gradient(180deg,rgba(0,0,0,0.06)_1px,transparent_1px)] bg-[length:12.5%_100%,100%_50%] opacity-80 dark:bg-[linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.05)_1px,transparent_1px)]" />
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-primary-500/45 to-transparent dark:via-primary-400/35" />
      <div className="absolute left-2 top-1/2 z-10 -translate-y-1/2 select-none text-[11px] font-medium text-default-400/60 dark:text-default-500/60">{t('spectrum.collapsed')}</div>
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
        aria-label={t('spectrum.restore')}
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
  frequencyBandOverlays = [],
  onFrequencyBandOverlayPreviewChange,
  onFrequencyBandOverlayCommit,
  showPopOut = true,
  onPopOutChange,
  showMarkers = true,
  topLeftOverlayInset,
}) => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const { operators } = useOperators();
  const { activeProfileId } = useProfiles();
  const radioConnection = useRadioConnectionState();
  const { currentMode, currentRadioFrequency, engineMode } = useRadioModeState();
  const { pttStatus } = usePTTState();
  const { splitEnabled, splitTxFrequency } = useSplitState();
  const canSetFrequency = useCan('execute', 'RadioFrequency');
  const ability = useAbility();
  const canWriteFrequency = canWriteRadioFrequency(canSetFrequency, radioConnection.coreCapabilities);
  const canWriteTargetFrequency = useCallback((frequency: number) => (
    canWriteFrequency && canExecuteRadioFrequency(ability, frequency)
  ), [ability, canWriteFrequency]);
  const { capabilities, selectedKind, subscribedKind, sessionState, setSelectedKind, setSubscribedKind } = useSpectrum();
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
  const openWebRXStreamRange = streamController.getFullRange(OPENWEBRX_SDR_SOURCE);
  const isTransmitting = pttStatus.isTransmitting;
  const [actualRange, setActualRange] = useState<{ min: number; max: number } | null>(null);
  const [persistedRangeSettings, setPersistedRangeSettings] = useState<PersistedRangeSettings>(() => loadPersistedRangeSettings());
  const [openWebRXViewport, setOpenWebRXViewport] = useState<OpenWebRXViewport | null>(() => readOpenWebRXViewport(activeProfileId));
  const [isCollapsed, setIsCollapsed] = useState(() => readSpectrumSubscriptionPaused());
  const [radioSdrOptimisticDisplayState, setRadioSdrOptimisticDisplayState] = useState<RadioSdrOptimisticDisplayState>(RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE);
  const openWebRXPanStateRef = useRef<{ startX: number; startCenterHz: number; width: number } | null>(null);
  const radioSdrOptimisticContextRef = useRef<{
    isActive: boolean;
    baselineFrequencyHz: number | null;
  }>({
    isActive: false,
    baselineFrequencyHz: null,
  });
  const radioSdrOptimisticDisplayStateRef = useRef<RadioSdrOptimisticDisplayState>(RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE);
  const radioSdrOptimisticDisplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const radioSdrServerSyncHoldUntilRef = useRef(0);
  const radioSdrServerSyncHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseRadioSdrFrequencyRef = useRef<number | null>(null);
  const lastAcceptedSpectrumFrameAtRef = useRef(Date.now());
  const spectrumNoFrameRetryCountRef = useRef(0);
  const radioServiceRef = useRef(connection.state.radioService);
  const hasActiveSpectrumSubscriptionRef = useRef(false);
  const [spectrumRecoveryState, setSpectrumRecoveryState] = useState<{
    isStale: boolean;
    retryCount: number;
    exhausted: boolean;
  }>({
    isStale: false,
    retryCount: 0,
    exhausted: false,
  });

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
  const activeSpectrumKind = subscribedKind ?? effectiveSelectedKind;
  const isAudioSpectrumSelected = effectiveSelectedKind === AUDIO_SOURCE;
  const isRadioSdrSelected = effectiveSelectedKind === RADIO_SDR_SOURCE;
  const isOpenWebRXSdrSelected = effectiveSelectedKind === OPENWEBRX_SDR_SOURCE;
  const isVoiceMode = engineMode === 'voice';
  const isCwMode = engineMode === 'cw';
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
  const radioSdrDragFrequencyStepHz = getRadioSdrDragFrequencyStepHz(engineMode);
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
  const baseRadioSdrFrequency = sessionState?.currentRadioFrequency ?? currentRadioFrequency ?? null;
  baseRadioSdrFrequencyRef.current = baseRadioSdrFrequency;
  radioServiceRef.current = connection.state.radioService;
  hasActiveSpectrumSubscriptionRef.current = !isCollapsed && Boolean(subscribedKind);
  const effectiveRadioSdrFrequency = isRadioSdrSelected && !isFixedSpectrumMode
    ? resolveRadioSdrOptimisticDisplayFrequencyHz(radioSdrOptimisticDisplayState, baseRadioSdrFrequency)
    : baseRadioSdrFrequency;
  const spectrumReferenceFrequency = isRadioSdrSelected
    ? effectiveRadioSdrFrequency
    : null;
  const currentManualRangeSettings = isOpenWebRXSdrSelected
    ? (isOpenWebRXDetailMode
        ? persistedRangeSettings.openWebRxSdr.detail
        : persistedRangeSettings.openWebRxSdr.full)
    : isRadioSdrSelected
      ? persistedRangeSettings.radioSdr
      : persistedRangeSettings.audio.manual;
  const selectedSpectrumThemeId = persistedRangeSettings.themeId;
  const showCycleMarkers = persistedRangeSettings.showCycleMarkers;
  const cycleSlotMs = currentMode?.slotMs ?? null;
  const waterfallViewKey = `${effectiveSelectedKind}:${isOpenWebRXDetailMode ? 'detail' : 'main'}`;
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
  radioSdrOptimisticContextRef.current = {
    isActive: isRadioSdrSelected && !isFixedSpectrumMode && connection.state.isConnected && !isCollapsed,
    baselineFrequencyHz: sessionState?.currentRadioFrequency ?? currentRadioFrequency ?? null,
  };
  const canDragRadioSdrFrequency = Boolean(
    isRadioSdrSelected
    && !isFixedSpectrumMode
    && connection.state.isConnected
    && canWriteFrequency
    && canDragFrequency
    && frequencyGestureTarget === 'radio-frequency'
    && radioSdrDragFrequencyStepHz !== null
  );

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

  const handleCycleMarkersChange = useCallback((enabled: boolean) => {
    setPersistedRangeSettings(prev => ({
      ...prev,
      showCycleMarkers: enabled,
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

  const handleRadioSdrFrequencyGesture = useCallback(async (frequency: number, options: { stepHz?: number | null } = {}) => {
    if (!connection.state.isConnected || !canWriteFrequency || frequencyGestureTarget !== 'radio-frequency') {
      return;
    }

    const request = buildRadioSdrFrequencyRequest({
      engineMode,
      frequency,
      stepHz: options.stepHz ?? frequencyGestureStepHz,
    });
    if (!canUseRadioSdrFrequencyRequest(request, canWriteTargetFrequency)) {
      addToast({
        title: t('auth:errors.insufficient_permission'),
        color: 'warning',
        timeout: 2500,
      });
      return;
    }

    try {
      const response = await setRadioFrequencyWithIntent(request);
      if (response.success) {
        resetOperatorsAfterOperatingStateChange();
      }
    } catch (error) {
      logger.error('Failed to set radio frequency from SDR overlay', error);
    }
  }, [canWriteFrequency, canWriteTargetFrequency, connection.state.isConnected, engineMode, frequencyGestureStepHz, frequencyGestureTarget, resetOperatorsAfterOperatingStateChange, t]);

  const handleRadioFrequencyGesture = useCallback((frequency: number) => {
    if (!canWriteFrequency || frequencyGestureTarget !== 'radio-frequency') {
      return;
    }
    void handleRadioSdrFrequencyGesture(frequency);
  }, [canWriteFrequency, frequencyGestureTarget, handleRadioSdrFrequencyGesture]);

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

  const updateRadioSdrOptimisticDisplayState = useCallback((nextState: RadioSdrOptimisticDisplayState) => {
    if (radioSdrOptimisticDisplayTimerRef.current) {
      clearTimeout(radioSdrOptimisticDisplayTimerRef.current);
      radioSdrOptimisticDisplayTimerRef.current = null;
    }

    radioSdrOptimisticDisplayStateRef.current = nextState;
    setRadioSdrOptimisticDisplayState(nextState);

    if (nextState.status === 'idle') {
      return;
    }

    const delayMs = Math.max(0, nextState.expiresAt - Date.now());
    radioSdrOptimisticDisplayTimerRef.current = setTimeout(() => {
      radioSdrOptimisticDisplayTimerRef.current = null;
      radioSdrOptimisticDisplayStateRef.current = RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE;
      setRadioSdrOptimisticDisplayState(RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE);
    }, delayMs);
  }, []);

  const isRadioSdrServerFrequencySyncHeld = useCallback(() => (
    radioSdrServerSyncHoldUntilRef.current === Number.POSITIVE_INFINITY
    || (radioSdrServerSyncHoldUntilRef.current > 0 && Date.now() < radioSdrServerSyncHoldUntilRef.current)
  ), []);

  const clearRadioSdrServerFrequencySyncHold = useCallback(() => {
    if (radioSdrServerSyncHoldTimerRef.current) {
      clearTimeout(radioSdrServerSyncHoldTimerRef.current);
      radioSdrServerSyncHoldTimerRef.current = null;
    }
    radioSdrServerSyncHoldUntilRef.current = 0;
    streamController.setRadioSdrServerSyncHoldUntil(null);
  }, [streamController]);

  const handleRadioSdrDragActiveChange = useCallback((active: boolean) => {
    if (!canDragRadioSdrFrequency) {
      clearRadioSdrServerFrequencySyncHold();
      return;
    }

    if (radioSdrServerSyncHoldTimerRef.current) {
      clearTimeout(radioSdrServerSyncHoldTimerRef.current);
      radioSdrServerSyncHoldTimerRef.current = null;
    }

    const holdUntil = active
      ? Number.POSITIVE_INFINITY
      : Date.now() + RADIO_SDR_DRAG_SERVER_SYNC_RELEASE_HOLD_MS;
    radioSdrServerSyncHoldUntilRef.current = holdUntil;
    streamController.setRadioSdrServerSyncHoldUntil(holdUntil);

    if (!active) {
      radioSdrServerSyncHoldTimerRef.current = setTimeout(() => {
        radioSdrServerSyncHoldTimerRef.current = null;
        radioSdrServerSyncHoldUntilRef.current = 0;
        streamController.setRadioSdrServerSyncHoldUntil(null);
        const nextOptimisticState = reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency(
          radioSdrOptimisticDisplayStateRef.current,
          baseRadioSdrFrequencyRef.current,
          Date.now(),
        );
        if (nextOptimisticState !== radioSdrOptimisticDisplayStateRef.current) {
          updateRadioSdrOptimisticDisplayState(nextOptimisticState);
        }
      }, RADIO_SDR_DRAG_SERVER_SYNC_RELEASE_HOLD_MS);
    }
  }, [canDragRadioSdrFrequency, clearRadioSdrServerFrequencySyncHold, streamController, updateRadioSdrOptimisticDisplayState]);

  const clearRadioSdrOptimisticDisplayState = useCallback(() => {
    updateRadioSdrOptimisticDisplayState(RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE);
  }, [updateRadioSdrOptimisticDisplayState]);

  const applyRadioSdrOptimisticFrequencyPreview = useCallback((
    frequency: number,
    options: { sentAt?: number; stepHz?: number | null } = {},
  ) => {
    const context = radioSdrOptimisticContextRef.current;
    if (!context.isActive || !Number.isFinite(frequency)) {
      return;
    }

    const currentRange = streamController.getFullRange(RADIO_SDR_SOURCE);
    if (!currentRange) {
      return;
    }

    const targetFrequencyHz = Math.round(snapFrequencyToStep(frequency, options.stepHz));
    const sentAt = options.sentAt ?? Date.now();
    const baselineFrameCenterHz = currentRange.min + (currentRange.max - currentRange.min) / 2;
    const baselineFrequencyHz = chooseRadioSdrOptimisticBaselineFrequencyHz({
      frameRange: currentRange,
      currentRadioFrequencyHz: context.baselineFrequencyHz,
    });

    updateRadioSdrOptimisticDisplayState(createRadioSdrOptimisticDisplayPendingState({
      targetFrequencyHz,
      baselineFrequencyHz,
      baselineFrameCenterHz,
      sentAt,
      timeoutMs: RADIO_SDR_OPTIMISTIC_DISPLAY_PENDING_TIMEOUT_MS,
    }));
    streamController.setRadioSdrOptimisticFrequencyIntent({
      targetFrequencyHz,
      baselineFrequencyHz,
      baselineFrameCenterHz,
      baselineFrameRange: currentRange,
      sentAt,
    });
  }, [streamController, updateRadioSdrOptimisticDisplayState]);

  const handleRadioSdrFrequencyDragPreview = useCallback((frequency: number) => {
    if (!canDragRadioSdrFrequency) {
      return;
    }
    applyRadioSdrOptimisticFrequencyPreview(frequency, {
      stepHz: radioSdrDragFrequencyStepHz,
    });
  }, [applyRadioSdrOptimisticFrequencyPreview, canDragRadioSdrFrequency, radioSdrDragFrequencyStepHz]);

  const handleRadioSdrFrequencyDragCommit = useCallback((frequency: number) => {
    if (!canDragRadioSdrFrequency) {
      return;
    }
    void handleRadioSdrFrequencyGesture(frequency, {
      stepHz: radioSdrDragFrequencyStepHz,
    });
  }, [canDragRadioSdrFrequency, handleRadioSdrFrequencyGesture, radioSdrDragFrequencyStepHz]);

  useEffect(() => {
    return () => {
      if (radioSdrOptimisticDisplayTimerRef.current) {
        clearTimeout(radioSdrOptimisticDisplayTimerRef.current);
        radioSdrOptimisticDisplayTimerRef.current = null;
      }
      if (radioSdrServerSyncHoldTimerRef.current) {
        clearTimeout(radioSdrServerSyncHoldTimerRef.current);
        radioSdrServerSyncHoldTimerRef.current = null;
      }
      if (hasActiveSpectrumSubscriptionRef.current) {
        radioServiceRef.current?.subscribeSpectrum(null);
      }
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
    if (isCollapsed || !connection.state.isReady || !subscribedKind) {
      return;
    }

    connection.state.radioService?.subscribeSpectrum(subscribedKind);
  }, [connection.state.isReady, connection.state.radioService, isCollapsed, subscribedKind]);

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
      const frame = data as SpectrumFrame;
      const frameProfileId = frame.meta.profileId;
      if (frameProfileId !== undefined && activeProfileId !== null && frameProfileId !== activeProfileId) {
        return;
      }
      streamController.pushFrame(frame);
      if (frame.kind === activeSpectrumKind) {
        lastAcceptedSpectrumFrameAtRef.current = Date.now();
        spectrumNoFrameRetryCountRef.current = 0;
        setSpectrumRecoveryState({ isStale: false, retryCount: 0, exhausted: false });
      }
      if (frame.kind === RADIO_SDR_SOURCE && !isRadioSdrServerFrequencySyncHeld()) {
        const nextOptimisticState = confirmRadioSdrOptimisticDisplayStateWithFrame(
          radioSdrOptimisticDisplayStateRef.current,
          frame.frequencyRange,
          Date.now(),
          RADIO_SDR_OPTIMISTIC_DISPLAY_HOLD_TIMEOUT_MS,
        );
        if (nextOptimisticState !== radioSdrOptimisticDisplayStateRef.current) {
          updateRadioSdrOptimisticDisplayState(nextOptimisticState);
        }
      }
    };

    wsClient.onWSEvent('spectrumFrame', handleSpectrumFrame);
    return () => {
      wsClient.offWSEvent('spectrumFrame', handleSpectrumFrame);
    };
  }, [activeProfileId, activeSpectrumKind, connection.state.radioService, isCollapsed, isRadioSdrServerFrequencySyncHeld, streamController, updateRadioSdrOptimisticDisplayState]);

  useEffect(() => {
    lastAcceptedSpectrumFrameAtRef.current = Date.now();
    spectrumNoFrameRetryCountRef.current = 0;
    setSpectrumRecoveryState({ isStale: false, retryCount: 0, exhausted: false });

    if (isCollapsed || !connection.state.isReady || !connection.state.radioService || !subscribedKind) {
      return;
    }

    const timer = setInterval(() => {
      const elapsedMs = Date.now() - lastAcceptedSpectrumFrameAtRef.current;
      if (elapsedMs < SPECTRUM_NO_FRAME_STALE_MS) {
        return;
      }

      const nextRetryCount = spectrumNoFrameRetryCountRef.current + 1;
      if (nextRetryCount <= SPECTRUM_NO_FRAME_MAX_RETRIES) {
        spectrumNoFrameRetryCountRef.current = nextRetryCount;
        lastAcceptedSpectrumFrameAtRef.current = Date.now();
        setSpectrumRecoveryState({
          isStale: true,
          retryCount: nextRetryCount,
          exhausted: false,
        });
        connection.state.radioService?.retrySpectrumSubscription('no-frame-timeout');
        return;
      }

      setSpectrumRecoveryState({
        isStale: true,
        retryCount: spectrumNoFrameRetryCountRef.current,
        exhausted: true,
      });
    }, SPECTRUM_NO_FRAME_CHECK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [connection.state.isReady, connection.state.radioService, isCollapsed, subscribedKind]);

  useLayoutEffect(() => {
    streamController.updateContext({
      selectedKind: effectiveSelectedKind,
      openWebRXViewport: isOpenWebRXSdrSelected && !isOpenWebRXDetailMode ? openWebRXViewport : null,
      isOpenWebRXDetailMode,
    });
  }, [
    effectiveSelectedKind,
    isOpenWebRXDetailMode,
    isOpenWebRXSdrSelected,
    openWebRXViewport,
    streamController,
  ]);

  useEffect(() => {
    return subscribeRadioFrequencyIntent((intent) => {
      applyRadioSdrOptimisticFrequencyPreview(intent.frequency, {
        sentAt: intent.sentAt,
      });
    });
  }, [applyRadioSdrOptimisticFrequencyPreview]);

  useEffect(() => {
    if (!isRadioSdrSelected || isFixedSpectrumMode || !connection.state.isConnected || isCollapsed) {
      clearRadioSdrServerFrequencySyncHold();
      streamController.setRadioSdrOptimisticFrequencyIntent(null);
      clearRadioSdrOptimisticDisplayState();
    }
  }, [clearRadioSdrOptimisticDisplayState, clearRadioSdrServerFrequencySyncHold, connection.state.isConnected, isCollapsed, isFixedSpectrumMode, isRadioSdrSelected, streamController]);

  useEffect(() => {
    if (isRadioSdrServerFrequencySyncHeld()) {
      return;
    }

    const nextOptimisticState = reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency(
      radioSdrOptimisticDisplayStateRef.current,
      baseRadioSdrFrequency,
      Date.now(),
    );
    if (nextOptimisticState !== radioSdrOptimisticDisplayStateRef.current) {
      updateRadioSdrOptimisticDisplayState(nextOptimisticState);
    }
  }, [baseRadioSdrFrequency, isRadioSdrServerFrequencySyncHeld, updateRadioSdrOptimisticDisplayState]);

  useEffect(() => {
    setActualRange(null);
    streamController.reset();
    clearRadioSdrServerFrequencySyncHold();
    clearRadioSdrOptimisticDisplayState();
  }, [activeProfileId, clearRadioSdrOptimisticDisplayState, clearRadioSdrServerFrequencySyncHold, streamController]);

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
  const voiceOverlayIsInteractive = canWriteFrequency && Boolean(sessionState?.interaction.canDragVoiceOverlay);
  const displaySpectrumMarkers = React.useMemo(() => resolveSpectrumMarkerFrequencies({
    isOpenWebRXSdrSelected,
    isOpenWebRXDetailMode,
    showMarkers,
    showRxMarkers,
    showTxMarkers,
    isVoiceMode,
    isCwMode,
    rxFrequencies,
    txFrequencies,
  }), [
    isCwMode,
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
    isCwMode,
    rxFrequencies,
    txFrequencies,
  }), [
    isCwMode,
    isVoiceMode,
    rxFrequencies,
    showMarkers,
    txFrequencies,
  ]);
  const effectiveHoverFrequency = hoverFrequency;
  const openWebRXFullRange = isOpenWebRXSdrSelected ? (streamStatus.fullRange ?? openWebRXStreamRange) : null;
  const radioSdrTxBandOverlays = React.useMemo(() => buildRadioSdrTxBandOverlays({
    engineMode,
    isRadioSdrSelected,
    currentRadioFrequency: effectiveRadioSdrFrequency,
    splitEnabled,
    splitTxFrequency,
    voice: sessionState?.voice,
    voiceOverlayIsInteractive,
  }), [effectiveRadioSdrFrequency, engineMode, isRadioSdrSelected, sessionState?.voice, splitEnabled, splitTxFrequency, voiceOverlayIsInteractive]);
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
    const waitingText = spectrumRecoveryState.exhausted
      ? t('spectrum.noData')
      : spectrumRecoveryState.isStale
        ? t('spectrum.retrying', {
            count: spectrumRecoveryState.retryCount,
            max: SPECTRUM_NO_FRAME_MAX_RETRIES,
          })
        : t('spectrum.waiting');
    return (
      <div className={`relative flex items-center justify-center ${className}`} style={{ height }}>
        <div className="text-default-400">{waitingText}</div>
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
        key={waterfallViewKey}
        controller={streamController}
        height={height}
        minDb={currentManualRangeSettings.minDb}
        maxDb={currentManualRangeSettings.maxDb}
        autoRange={!isRadioSdrSelected && !isOpenWebRXSdrSelected && audioRangeSettings.mode === 'auto'}
        autoRangeConfig={audioRangeSettings.auto}
        themeId={selectedSpectrumThemeId}
        showCycleMarkers={showCycleMarkers}
        cycleSlotMs={cycleSlotMs}
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
        dragFrequencyStepHz={radioSdrDragFrequencyStepHz}
        dragFrequencyCommitIntervalMs={RADIO_SDR_DRAG_FREQUENCY_COMMIT_INTERVAL_MS}
        txBandOverlays={radioSdrTxBandOverlays}
        frequencyBandOverlays={isAudioSpectrumSelected ? frequencyBandOverlays : []}
        presetMarkers={presetMarkers}
        rxFrequencies={displaySpectrumMarkers.rxFrequencies}
        txFrequencies={displaySpectrumMarkers.txFrequencies}
        onTxFrequencyChange={displayTxFrequencyChange}
        onTxBandOverlayFrequencyChange={voiceOverlayIsInteractive ? (_id, frequency) => void handleRadioSdrFrequencyGesture(frequency) : undefined}
        onFrequencyBandOverlayPreviewChange={isAudioSpectrumSelected ? onFrequencyBandOverlayPreviewChange : undefined}
        onFrequencyBandOverlayCommit={isAudioSpectrumSelected ? onFrequencyBandOverlayCommit : undefined}
        onPresetMarkerClick={presetMarkers.length > 0 && canWriteFrequency && frequencyGestureTarget === 'radio-frequency' ? handleRadioFrequencyGesture : undefined}
        onDragFrequencyPreview={canDragRadioSdrFrequency ? handleRadioSdrFrequencyDragPreview : undefined}
        onDragFrequencyActiveChange={canDragRadioSdrFrequency ? handleRadioSdrDragActiveChange : undefined}
        enableHorizontalWheelFrequency={canDragRadioSdrFrequency}
        onDragFrequencyChange={
          canDragRadioSdrFrequency
            ? handleRadioSdrFrequencyDragCommit
            : undefined
        }
        onDoubleClickSetFrequency={
          frequencyGestureTarget === 'radio-frequency' && canDoubleClickSetFrequency && canWriteFrequency
            ? handleRadioFrequencyGesture
            : undefined
        }
        onRightClickSetFrequency={
          isOpenWebRXSdrSelected
            ? (isOpenWebRXDetailMode ? handleRightClickSetFrequency : undefined)
            : frequencyGestureTarget === 'radio-frequency'
            ? (canRightClickSetFrequency && canWriteFrequency ? handleRadioFrequencyGesture : undefined)
            : (showMarkers && canRightClickSetFrequency ? handleRightClickSetFrequency : undefined)
        }
        onActualRangeChange={setActualRange}
        hoverFrequency={effectiveHoverFrequency}
        isTransmitting={isTransmitting}
        className="bg-transparent"
      />
      {spectrumRecoveryState.isStale && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white/85 backdrop-blur-sm">
          {spectrumRecoveryState.exhausted
            ? t('spectrum.noData')
            : t('spectrum.retrying', {
                count: spectrumRecoveryState.retryCount,
                max: SPECTRUM_NO_FRAME_MAX_RETRIES,
              })}
        </div>
      )}

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
                <div className="flex items-center justify-between gap-3 rounded-lg bg-default-100/50 px-3 py-2 dark:bg-default-50/10">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-default-700">
                      {t('spectrum.cycleMarkers')}
                    </div>
                    <div className="text-[11px] leading-tight text-default-400">
                      {t('spectrum.cycleMarkersDescription')}
                    </div>
                  </div>
                  <Switch
                    size="sm"
                    isSelected={showCycleMarkers}
                    onValueChange={handleCycleMarkersChange}
                    aria-label={t('spectrum.cycleMarkers')}
                  />
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
