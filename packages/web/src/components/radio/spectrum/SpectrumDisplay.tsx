import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Accordion, AccordionItem, Button, Input, Popover, PopoverContent, PopoverTrigger, Slider, Switch, Tab, Tabs, Tooltip } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { ArrowsPointingOutIcon, ChevronDownIcon, ChevronUpIcon, Cog6ToothIcon, MinusIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { AudioInputSignalType, EngineMode, SpectrumCustomSettings, SpectrumFrame, SpectrumKind, SpectrumLevelDescriptor, SpectrumLevelDomain, SpectrumPreset, SpectrumSessionFrequencyOverlay, SpectrumSessionViewMode, SpectrumViewport, SystemStatus, TciSpectrumSettings } from '@tx5dr/contracts';
import { UserRole } from '@tx5dr/contracts';
import { api, getBandFromFrequency } from '@tx5dr/core';
import { useConnection, useCurrentOperatorId, useOperators, useProfiles, usePTTState, useRadioConnectionState, useRadioModeState, useRadioState, useCapabilityState, useCapabilityDescriptor, useSpectrum, useSplitState } from '../../../store/radioStore';
import { useAbility, useCan, useHasMinRole } from '../../../store/authStore';
import { createLogger } from '../../../utils/logger';
import { setPreferredSpectrumKind } from '../../../utils/spectrumPreferences';
import { useTargetRxFrequencies, type RxFrequency } from '../../../hooks/useTargetRxFrequencies';
import { useCapabilityWriter } from '../../../radio-capability/CapabilityRegistry';
import { useTxFrequencies, type TxFrequency } from '../../../hooks/useTxFrequencies';
import { getWaterfallCanvasPixelRatio, WebGLWaterfall, WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ, WATERFALL_MAX_HISTORY_ROWS } from './WebGLWaterfall';
import type { AutoRangeConfig, FrequencyBandOverlay, FrequencyBandOverlayChange, PresetMarker, TxBandOverlay } from './WebGLWaterfall';
import { SpectrumStreamController, type RadioSdrCenterViewMode } from '../../../spectrum/SpectrumStreamController';
import {
  ICOM_RADIO_SDR_FREQUENCY_AXIS_CALIBRATION,
  IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  createFrequencyAxisTransform,
} from '../../../spectrum/frequencyAxisCalibration';
import { readSpectrumSubscriptionPaused, setSpectrumSubscriptionPaused } from '../../../utils/spectrumSubscriptionPause';
import { resetOperatorsForOperatingStateChange } from '../../../utils/operatorReset';
import { canExecuteRadioFrequency, canWriteRadioFrequency, isFakeFrequencySupportedMode } from '../../../utils/radioControl';
import { setRadioFrequencyWithIntent, subscribeRadioFrequencyIntent, type SetRadioFrequencyParams } from '../../../utils/radioFrequencyIntent';
import { deriveSpectrumCustomSettings, SpectrumAnalysisSettings } from './SpectrumAnalysisSettings';
import { TciSpectrumSettingsPanel } from './TciSpectrumSettings';
import { SpectrumRenderHost, type SpectrumPresentation } from './SpectrumRenderHost';
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
import {
  STRATEGY_FREQUENCY_PICK_EVENT,
  type StrategyFrequencyPickRequest,
} from '../../../utils/strategyFrequencyPick';
import { formatFrequencyMHz } from '../../../utils/frequencyMHz';

const logger = createLogger('SpectrumDisplay');
const SPECTRUM_NO_FRAME_STALE_MS = 10_000;
const SPECTRUM_NO_FRAME_CHECK_MS = 1_000;
const SPECTRUM_NO_FRAME_MAX_RETRIES = 3;
const TCI_DIGITAL_AUTO_ZOOM_DELAY_MS = 1000;
const TCI_DIGITAL_AUTO_ZOOM_PADDING_RATIO = 0.25;
const TCI_DIGITAL_AUTO_ZOOM_MIN_PADDING_HZ = 200;
const TCI_DIGITAL_AUTO_ZOOM_MANUAL_INTENT_TTL_MS = 5_000;
const TCI_DIGITAL_AUTO_ZOOM_FREQUENCY_TOLERANCE_HZ = 5_000;

type ElectronWindowHelper = Window & {
  electronAPI?: {
    window: {
      openSpectrumWindow: () => Promise<void>;
    };
  };
};

const AUDIO_WATERFALL_HISTORY_ROWS = 1024;
const RADIO_SDR_WATERFALL_HISTORY_ROWS = WATERFALL_MAX_HISTORY_ROWS;
const OPENWEBRX_WATERFALL_HISTORY_ROWS = 40;
const SPECTRUM_HISTORY_LIMITS = {
  audio: AUDIO_WATERFALL_HISTORY_ROWS,
  'radio-sdr': RADIO_SDR_WATERFALL_HISTORY_ROWS,
  'openwebrx-sdr': OPENWEBRX_WATERFALL_HISTORY_ROWS,
} satisfies Partial<Record<SpectrumKind, number>>;

function resolveSpectrumHistoryRows(kind: SpectrumKind | null, height: number): number {
  const capacity = kind ? SPECTRUM_HISTORY_LIMITS[kind] ?? WATERFALL_MAX_HISTORY_ROWS : WATERFALL_MAX_HISTORY_ROWS;
  const pixelRatio = typeof window === 'undefined' ? 1 : getWaterfallCanvasPixelRatio(window.devicePixelRatio);
  return Math.max(1, Math.min(capacity, Math.ceil(Math.max(1, height) * pixelRatio)));
}
const SETTINGS_STORAGE_KEY = 'spectrum-range-settings';
// 虚拟频差低功率弱警告相关常量
const FAKE_FREQ_COMFORT_MIN_HZ = 500;   // 发射音频甜区下界（baseband Hz）
const FAKE_FREQ_COMFORT_MAX_HZ = 2300;  // 发射音频甜区上界（baseband Hz）
const FAKE_FREQ_OUTPUT_LOW_RATIO = 0.25;   // 实测输出/量程 低于此比例视为功率偏低
const FAKE_FREQ_OUTPUT_LOW_PERCENT = 25;   // 无瓦数时按百分比判断
const FAKE_FREQ_SETTING_LOW_RATIO = 0.5;   // RF 功率设置低于量程一半视为用户主动 QRP，不提示
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
const TCI_MIN_LOCAL_VIEWPORT_SPAN_HZ = 200;
const WIDE_RADIO_DDS_FREQUENCY_TOLERANCE_HZ = 5_000;
const WIDE_RADIO_VIEWPORT_FREQUENCY_CHANGE_THRESHOLD_HZ = 10_000;
const TCI_CLIENT_VIEWPORT_DISPLAY_BINS = 4096;
const TCI_VIEWPORT_SYNC_DEBOUNCE_MS = 60;

const DEFAULT_AUTO_CONFIG: AutoRangeConfig = {
  updateInterval: 10,
  minPercentile: 15,
  maxPercentile: 99,
  rangeExpansionFactor: 4.0,
};

interface SpectrumDisplayProps {
  className?: string;
  height?: number;
  /** Standalone windows opt into the trace + waterfall presentation. */
  presentation?: SpectrumPresentation;
  hoverFrequency?: number | null;
  frequencyBandOverlays?: FrequencyBandOverlay[];
  onFrequencyBandOverlayPreviewChange?: (id: string, change: FrequencyBandOverlayChange) => void;
  onFrequencyBandOverlayCommit?: (id: string, change: FrequencyBandOverlayChange) => void;
  showPopOut?: boolean;
  onPopOutChange?: (isPopedOut: boolean) => void;
  onCollapsedChange?: (isCollapsed: boolean) => void;
  showMarkers?: boolean;
  topLeftOverlayInset?: {
    top?: number;
    left?: number;
  };
}

export interface ManualRangeSettings {
  minDb: number;
  maxDb: number;
}

export interface AudioRangeSettings {
  mode: 'auto' | 'manual';
  manual: ManualRangeSettings;
  auto: AutoRangeConfig;
}

type SpectrumEngineState = SystemStatus['engineState'] | null | undefined;

interface SpectrumNoFrameRecoveryGateInput {
  connectionReady: boolean;
  selectedKind: SpectrumKind;
  isTransmitting: boolean;
  isEngineRunning: boolean | null | undefined;
  engineState: SpectrumEngineState;
}

export interface SpectrumRecoveryStateSnapshot {
  isStale: boolean;
  retryCount: number;
  exhausted: boolean;
}

export const SPECTRUM_RECOVERY_IDLE_STATE: SpectrumRecoveryStateSnapshot = {
  isStale: false,
  retryCount: 0,
  exhausted: false,
};

export type SpectrumEmptyStatusKey =
  | 'engineNotStarted'
  | 'transmittingPaused'
  | 'noData'
  | 'retrying'
  | 'waiting';

export function isSpectrumEngineNotStarted({
  connectionReady,
  isEngineRunning,
  engineState,
}: Pick<SpectrumNoFrameRecoveryGateInput, 'connectionReady' | 'isEngineRunning' | 'engineState'>): boolean {
  return connectionReady && (engineState === 'idle' || isEngineRunning === false);
}

export function shouldPauseSpectrumNoFrameRecovery({
  connectionReady,
  selectedKind,
  isTransmitting,
  isEngineRunning,
  engineState,
}: SpectrumNoFrameRecoveryGateInput): boolean {
  if (isSpectrumEngineNotStarted({ connectionReady, isEngineRunning, engineState })) {
    return true;
  }

  return selectedKind === RADIO_SDR_SOURCE && isTransmitting;
}

export function resolveSpectrumEmptyStatusKey({
  engineNotStarted,
  radioSdrTransmitPaused,
  recoveryState,
}: {
  engineNotStarted: boolean;
  radioSdrTransmitPaused: boolean;
  recoveryState: SpectrumRecoveryStateSnapshot;
}): SpectrumEmptyStatusKey {
  if (engineNotStarted) {
    return 'engineNotStarted';
  }
  if (radioSdrTransmitPaused) {
    return 'transmittingPaused';
  }
  if (recoveryState.exhausted) {
    return 'noData';
  }
  if (recoveryState.isStale) {
    return 'retrying';
  }
  return 'waiting';
}

export function areSpectrumRecoveryStatesEqual(
  left: SpectrumRecoveryStateSnapshot,
  right: SpectrumRecoveryStateSnapshot,
): boolean {
  return left.isStale === right.isStale
    && left.retryCount === right.retryCount
    && left.exhausted === right.exhausted;
}

export function resolveSpectrumRecoveryStateAfterFrame(
  current: SpectrumRecoveryStateSnapshot,
): SpectrumRecoveryStateSnapshot {
  return areSpectrumRecoveryStatesEqual(current, SPECTRUM_RECOVERY_IDLE_STATE)
    ? current
    : SPECTRUM_RECOVERY_IDLE_STATE;
}

export function resolveAudioRangeSettingsForModeChange(
  current: AudioRangeSettings,
  nextMode: AudioRangeSettings['mode'],
  actualRange: { min: number; max: number } | null,
): AudioRangeSettings {
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
}

type SpectrumFrequencyRangeMode = 'baseband' | 'absolute-center' | 'absolute-fixed' | 'absolute-windowed';

export function normalizeRadioSdrCenterViewMode(value: unknown): RadioSdrCenterViewMode {
  return value === 'left' || value === 'right' || value === 'full' ? value : 'full';
}

export function canShowRadioSdrCenterViewSetting({
  isRadioSdrSelected,
  frequencyRangeMode,
  viewMode = 'radio-center',
}: {
  isRadioSdrSelected: boolean;
  frequencyRangeMode: SpectrumFrequencyRangeMode;
  viewMode?: SpectrumSessionViewMode;
}): boolean {
  return isRadioSdrSelected && viewMode === 'radio-center' && frequencyRangeMode === 'absolute-center';
}

export function resolveRadioSdrCenterViewContext({
  isRadioSdrSelected,
  frequencyRangeMode,
  centerViewMode,
  referenceFrequencyHz,
  viewMode = 'radio-center',
}: {
  isRadioSdrSelected: boolean;
  frequencyRangeMode: SpectrumFrequencyRangeMode;
  centerViewMode: RadioSdrCenterViewMode;
  referenceFrequencyHz: number | null;
  viewMode?: SpectrumSessionViewMode;
}): { centerViewMode: RadioSdrCenterViewMode; referenceFrequencyHz: number | null } {
  if (
    !canShowRadioSdrCenterViewSetting({ isRadioSdrSelected, frequencyRangeMode, viewMode })
    || centerViewMode === 'full'
    || typeof referenceFrequencyHz !== 'number'
    || !Number.isFinite(referenceFrequencyHz)
  ) {
    return {
      centerViewMode: 'full',
      referenceFrequencyHz: null,
    };
  }

  return {
    centerViewMode,
    referenceFrequencyHz,
  };
}

interface LegacyAudioRangeSettings {
  manual?: Partial<ManualRangeSettings>;
  auto?: Partial<AutoRangeConfig>;
  mode?: 'auto' | 'manual';
}

interface PersistedRangeSettings {
  themeId: SpectrumThemeId;
  showCycleMarkers: boolean;
  radioSdrCenterViewMode: RadioSdrCenterViewMode;
  audio: AudioRangeSettings;
  radioSdr: Record<SpectrumLevelDomain, ManualRangeSettings>;
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

export const RADIO_SDR_RANGE_LIMITS: Record<SpectrumLevelDomain, { min: number; max: number }> = {
  dbfs: { min: -120, max: 0 },
  'calibrated-db': { min: -120, max: 0 },
  raw: { min: 0, max: 255 },
};

export const DEFAULT_RADIO_SDR_RANGE_SETTINGS: Record<SpectrumLevelDomain, ManualRangeSettings> = {
  dbfs: { minDb: -120, maxDb: -40 },
  'calibrated-db': { minDb: -120, maxDb: 0 },
  raw: { minDb: 0, maxDb: 255 },
};

const RAW_RADIO_SDR_LEVEL: SpectrumLevelDescriptor = {
  domain: 'raw',
  unit: 'Level',
  reference: 'none',
  calibrated: false,
  min: 0,
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
  radioSdrCenterViewMode: 'full',
  audio: {
    mode: 'auto',
    manual: {
      minDb: -35,
      maxDb: 10,
    },
    auto: DEFAULT_AUTO_CONFIG,
  },
  radioSdr: {
    dbfs: cloneManualRangeSettings(DEFAULT_RADIO_SDR_RANGE_SETTINGS.dbfs),
    'calibrated-db': cloneManualRangeSettings(DEFAULT_RADIO_SDR_RANGE_SETTINGS['calibrated-db']),
    raw: cloneManualRangeSettings(DEFAULT_RADIO_SDR_RANGE_SETTINGS.raw),
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
  radioMode,
}: {
  engineMode: EngineMode;
  frequency: number;
  stepHz: number | null | undefined;
  radioMode?: string | null;
}): SetRadioFrequencyParams | null {
  const snappedFrequency = snapFrequencyToStep(frequency, stepHz);
  const roundedFrequency = Math.round(snappedFrequency);
  const description = `${formatFrequencyMHz(snappedFrequency)} MHz`;

  if (engineMode === 'voice' || engineMode === 'image') {
    return {
      frequency: roundedFrequency,
      mode: engineMode === 'image'
        ? (radioMode?.toUpperCase() === 'FAX' ? 'FAX' : 'SSTV')
        : 'VOICE',
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
): request is SetRadioFrequencyParams {
  return request !== null && canWriteTargetFrequency(request.frequency);
}

function mapSessionFrequencyOverlay(overlay: SpectrumSessionFrequencyOverlay): TxBandOverlay {
  return {
    id: overlay.id,
    label: overlay.label,
    lineFrequency: overlay.lineFrequency,
    rangeStartFrequency: overlay.rangeStartFrequency,
    rangeEndFrequency: overlay.rangeEndFrequency,
    draggable: overlay.draggable,
    variant: overlay.variant,
    frequencyTarget: overlay.frequencyTarget,
  };
}

export function resolveTciDigitalAutoZoomRange(
  bounds: { min: number; max: number },
  rxRange: { min: number; max: number },
): { min: number; max: number } | null {
  if (
    !Number.isFinite(bounds.min)
    || !Number.isFinite(bounds.max)
    || bounds.max <= bounds.min
    || !Number.isFinite(rxRange.min)
    || !Number.isFinite(rxRange.max)
    || rxRange.max <= rxRange.min
  ) return null;
  const span = rxRange.max - rxRange.min;
  const padding = Math.max(TCI_DIGITAL_AUTO_ZOOM_MIN_PADDING_HZ, span * TCI_DIGITAL_AUTO_ZOOM_PADDING_RATIO);
  const nextRange = {
    min: Math.max(bounds.min, rxRange.min - padding),
    max: Math.min(bounds.max, rxRange.max + padding),
  };
  return nextRange.max > nextRange.min ? nextRange : null;
}

/**
 * Resolve the FT8/FT4 presentation range against the latest radio frequency.
 *
 * The session overlay is authoritative for the RX filter offsets, but it can
 * arrive one websocket turn after a user changes frequency. Reusing those
 * offsets around the latest absolute frequency keeps the one-second preview
 * attached to the user's new VFO instead of briefly zooming back to the old
 * band's window.
 */
export function resolveTciDigitalAutoZoomTargetRange(
  bounds: { min: number; max: number },
  overlay: Pick<SpectrumSessionFrequencyOverlay, 'lineFrequency' | 'rangeStartFrequency' | 'rangeEndFrequency'>,
  referenceFrequency?: number | null,
): { min: number; max: number } | null {
  if (
    !Number.isFinite(overlay.lineFrequency)
    || !Number.isFinite(overlay.rangeStartFrequency)
    || !Number.isFinite(overlay.rangeEndFrequency)
    || overlay.rangeEndFrequency <= overlay.rangeStartFrequency
  ) {
    return null;
  }

  const centerFrequency = typeof referenceFrequency === 'number' && Number.isFinite(referenceFrequency)
    ? referenceFrequency
    : overlay.lineFrequency;
  const rxRange = {
    min: centerFrequency + (overlay.rangeStartFrequency - overlay.lineFrequency),
    max: centerFrequency + (overlay.rangeEndFrequency - overlay.lineFrequency),
  };
  return resolveTciDigitalAutoZoomRange(bounds, rxRange);
}

function buildTciDigitalAutoZoomKey(modeName: string | null, frequency: number | null): string | null {
  if (!modeName) return null;
  return `${modeName}:${typeof frequency === 'number' && Number.isFinite(frequency) ? Math.round(frequency) : 'unknown'}`;
}

/**
 * Distinguish a normal radio-frequency change from an IQ/DDS center update.
 * DDS edge tuning leaves the operating frequency unchanged, while a band/VFO
 * switch changes it and eventually produces a new native frame envelope. A
 * known band transition is preferred over a raw-Hz threshold so boundary
 * changes are handled consistently with the rest of the radio UI.
 */
export function shouldResetWideRadioViewportForFrequencyChange({
  previousFrequency,
  nextFrequency,
  previousNativeRange,
  nextNativeRange,
  currentViewport = null,
  ddsTuneActive = false,
}: {
  previousFrequency: number | null;
  nextFrequency: number | null;
  previousNativeRange: { min: number; max: number } | null;
  nextNativeRange: { min: number; max: number } | null;
  currentViewport?: { min: number; max: number } | null;
  ddsTuneActive?: boolean;
}): boolean {
  if (
    typeof previousFrequency !== 'number'
    || !Number.isFinite(previousFrequency)
    || typeof nextFrequency !== 'number'
    || !Number.isFinite(nextFrequency)
    || !nextNativeRange
  ) {
    return false;
  }
  const frequencyDelta = Math.abs(nextFrequency - previousFrequency);
  if (ddsTuneActive && frequencyDelta < WIDE_RADIO_DDS_FREQUENCY_TOLERANCE_HZ) return false;
  const crossedBand = getBandFromFrequency(previousFrequency) !== getBandFromFrequency(nextFrequency);
  const nativeRangeChanged = !previousNativeRange
    || previousNativeRange.min !== nextNativeRange.min
    || previousNativeRange.max !== nextNativeRange.max;
  const viewportOutside = Boolean(
    currentViewport
    && (currentViewport.max <= nextNativeRange.min || currentViewport.min >= nextNativeRange.max),
  );
  if (
    !crossedBand
    && frequencyDelta < WIDE_RADIO_VIEWPORT_FREQUENCY_CHANGE_THRESHOLD_HZ
    && !viewportOutside
  ) {
    return false;
  }
  return nativeRangeChanged || viewportOutside;
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

function cloneRadioSdrRangeSettings(
  settings: Record<SpectrumLevelDomain, ManualRangeSettings>,
): Record<SpectrumLevelDomain, ManualRangeSettings> {
  return {
    dbfs: cloneManualRangeSettings(settings.dbfs),
    'calibrated-db': cloneManualRangeSettings(settings['calibrated-db']),
    raw: cloneManualRangeSettings(settings.raw),
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

export function normalizeRadioSdrRangeSettings(settings: unknown): Record<SpectrumLevelDomain, ManualRangeSettings> {
  const defaults = DEFAULT_RADIO_SDR_RANGE_SETTINGS;
  if (!settings || typeof settings !== 'object') {
    return cloneRadioSdrRangeSettings(defaults);
  }

  const value = settings as Record<string, unknown>;
  const legacyRange = normalizeManualRangeSettings(value as Partial<ManualRangeSettings>, defaults.raw);
  const hasLegacyShape = typeof value.minDb === 'number' || typeof value.maxDb === 'number';
  if (hasLegacyShape) {
    return {
      dbfs: cloneManualRangeSettings(defaults.dbfs),
      'calibrated-db': cloneManualRangeSettings(defaults['calibrated-db']),
      raw: legacyRange,
    };
  }

  return {
    dbfs: normalizeManualRangeSettings(value.dbfs as Partial<ManualRangeSettings> | undefined, defaults.dbfs),
    'calibrated-db': normalizeManualRangeSettings(value['calibrated-db'] as Partial<ManualRangeSettings> | undefined, defaults['calibrated-db']),
    raw: normalizeManualRangeSettings(value.raw as Partial<ManualRangeSettings> | undefined, defaults.raw),
  };
}

function clampRangeValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function constrainManualRangeSettings(
  settings: ManualRangeSettings,
  limits: { min: number; max: number },
): ManualRangeSettings {
  const minDb = clampRangeValue(settings.minDb, limits.min, limits.max - 1);
  const maxDb = clampRangeValue(settings.maxDb, minDb + 1, limits.max);
  return { minDb, maxDb };
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
        radioSdrCenterViewMode: DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdrCenterViewMode,
        audio: cloneAudioRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.audio),
        radioSdr: cloneRadioSdrRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
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
        radioSdrCenterViewMode: normalizeRadioSdrCenterViewMode((parsed as Partial<PersistedRangeSettings>).radioSdrCenterViewMode),
        audio: normalizeAudioRangeSettings(
          (parsed as Partial<PersistedRangeSettings>).audio,
          DEFAULT_PERSISTED_RANGE_SETTINGS.audio
        ),
        radioSdr: normalizeRadioSdrRangeSettings(
          (parsed as Partial<PersistedRangeSettings>).radioSdr,
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
      radioSdrCenterViewMode: DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdrCenterViewMode,
      audio: normalizeAudioRangeSettings(
        parsed as LegacyAudioRangeSettings,
        DEFAULT_PERSISTED_RANGE_SETTINGS.audio
      ),
      radioSdr: cloneRadioSdrRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
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
      radioSdrCenterViewMode: DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdrCenterViewMode,
      audio: cloneAudioRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.audio),
      radioSdr: cloneRadioSdrRangeSettings(DEFAULT_PERSISTED_RANGE_SETTINGS.radioSdr),
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
          visualFrequencyOffsetHz={WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ}
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

/**
 * 虚拟频差低功率弱警告判定器：订阅高频 meterData 等，计算需要提示的操作员集合，
 * 仅在结果集变化时通过 onChange 回写，避免高频 meter 刷新拖累整个频谱子树重渲染。
 * 本组件不渲染任何内容。
 */
const FakeFreqLowPowerWatcher: React.FC<{
  active: boolean;
  onChange: (ids: string[]) => void;
}> = ({ active, onChange }) => {
  const { state: radioState } = useRadioState();
  const { pttStatus } = usePTTState();
  const txFrequencies = useTxFrequencies();
  const rfPowerState = useCapabilityState('rf_power');
  const rfPowerDescriptor = useCapabilityDescriptor('rf_power');
  const lastKeyRef = useRef<string>('');

  const ids = useMemo(() => {
    if (!active) return [];
    if (!pttStatus.isTransmitting || pttStatus.operatorIds.length === 0) return [];

    // 实测输出功率是否偏低
    const power = radioState.meterData?.power;
    if (!power) return [];
    let outputLow = false;
    if (power.watts != null && power.maxWatts != null && power.maxWatts > 0) {
      outputLow = power.watts / power.maxWatts < FAKE_FREQ_OUTPUT_LOW_RATIO;
    } else if (power.percent != null) {
      outputLow = power.percent < FAKE_FREQ_OUTPUT_LOW_PERCENT;
    }
    if (!outputLow) return [];

    // 电台 RF 功率设置被用户主动调低（QRP）则不提示
    if (typeof rfPowerState?.value === 'number' && rfPowerDescriptor?.range) {
      const { min, max } = rfPowerDescriptor.range;
      if (max > min && (rfPowerState.value - min) / (max - min) < FAKE_FREQ_SETTING_LOW_RATIO) return [];
    }

    // 仅对发射音频确实偏离甜区的操作员提示
    return txFrequencies
      .filter((tx) => pttStatus.operatorIds.includes(tx.operatorId)
        && (tx.frequency < FAKE_FREQ_COMFORT_MIN_HZ || tx.frequency > FAKE_FREQ_COMFORT_MAX_HZ))
      .map((tx) => tx.operatorId);
  }, [active, pttStatus.isTransmitting, pttStatus.operatorIds, radioState.meterData,
    rfPowerState?.value, rfPowerDescriptor?.range, txFrequencies]);

  useEffect(() => {
    const key = ids.join(',');
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      onChange(ids);
    }
  }, [ids, onChange]);

  return null;
};

export const SpectrumDisplay: React.FC<SpectrumDisplayProps> = ({
  className = '',
  height = 200,
  presentation = 'waterfall',
  hoverFrequency,
  frequencyBandOverlays = [],
  onFrequencyBandOverlayPreviewChange,
  onFrequencyBandOverlayCommit,
  showPopOut = true,
  onPopOutChange,
  onCollapsedChange,
  showMarkers = true,
  topLeftOverlayInset,
}) => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const { operators } = useOperators();
  const { activeProfileId, activeProfile } = useProfiles();
  const radioConnection = useRadioConnectionState();
  const { currentMode, currentRadioFrequency, engineMode, isEngineRunning, engineState, operatingState } = useRadioModeState();
  const { pttStatus } = usePTTState();
  const { splitTxFrequencyWritable } = useSplitState();
  const canSetFrequency = useCan('execute', 'RadioFrequency');
  const canControlRadio = useCan('execute', 'RadioControl');
  const tciIqSampleRateState = useCapabilityState('tci_iq_sample_rate');
  const tciIqSampleRateDescriptor = useCapabilityDescriptor('tci_iq_sample_rate');
  const writeRadioCapability = useCapabilityWriter();
  const [tciSpectrumSettings, setTciSpectrumSettings] = useState<TciSpectrumSettings | null>(null);
  const [tciSpectrumSettingsPending, setTciSpectrumSettingsPending] = useState(false);
  const canToggleInputSignal = useHasMinRole(UserRole.ADMIN);
  const canConfigureSpectrum = useHasMinRole(UserRole.ADMIN);
  const ability = useAbility();
  const [inputSignalTogglePending, setInputSignalTogglePending] = useState(false);
  const [spectrumPresetPending, setSpectrumPresetPending] = useState(false);
  const [strategyFrequencyPick, setStrategyFrequencyPick] = useState<StrategyFrequencyPickRequest | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      setStrategyFrequencyPick((event as CustomEvent<StrategyFrequencyPickRequest>).detail);
    };
    window.addEventListener(STRATEGY_FREQUENCY_PICK_EVENT, listener);
    return () => window.removeEventListener(STRATEGY_FREQUENCY_PICK_EVENT, listener);
  }, []);
  const inputSignalType: AudioInputSignalType =
    activeProfile?.audio?.inputSignalType === 'icom-12k-if' ? 'icom-12k-if' : 'af';
  const isIfInputSignal = inputSignalType === 'icom-12k-if';
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
  const spectrumRenderConfig = capabilities?.renderConfig ?? null;
  const [customSpectrumDraft, setCustomSpectrumDraft] = useState<SpectrumCustomSettings>(() => deriveSpectrumCustomSettings(spectrumRenderConfig));
  const [customSpectrumEditing, setCustomSpectrumEditing] = useState(false);
  const streamStatus = useSyncExternalStore(
    streamController.subscribeStatus,
    streamController.getStatusSnapshot,
    streamController.getStatusSnapshot
  );
  const openWebRXStreamRange = streamController.getFullRange(OPENWEBRX_SDR_SOURCE);
  const isTransmitting = pttStatus.isTransmitting;
  const actualRangeRef = useRef<{ min: number; max: number } | null>(null);
  const [persistedRangeSettings, setPersistedRangeSettings] = useState<PersistedRangeSettings>(() => loadPersistedRangeSettings());
  const [openWebRXViewport, setOpenWebRXViewport] = useState<OpenWebRXViewport | null>(() => readOpenWebRXViewport(activeProfileId));
  const [radioSdrViewport, setRadioSdrViewport] = useState<{ min: number; max: number } | null>(null);
  const previousWideRadioFrequencyRef = useRef<number | null>(null);
  const pendingWideRadioFrequencyChangeRef = useRef<{ previous: number; next: number } | null>(null);
  const previousWideNativeRangeRef = useRef<{ min: number; max: number } | null>(null);
  const tciViewportSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTciViewportRef = useRef<SpectrumViewport | null>(null);
  const tciDigitalAutoZoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tciDigitalAutoZoomScheduledKeyRef = useRef<string | null>(null);
  const tciDigitalAutoZoomManualIntentRef = useRef<{ frequencyHz: number; expiresAt: number } | null>(null);
  const tciDigitalAutoZoomFrequencyRef = useRef<number | null>(null);
  const tciDigitalAutoZoomWaitingKeyRef = useRef<string | null>(null);
  const spectrumViewportTransitionRef = useRef(false);
  const lastTciViewportTuneRef = useRef<number | null>(null);
  const tciDdsTuneRef = useRef<{ inFlight: boolean; pendingFrequencyHz: number | null }>({
    inFlight: false,
    pendingFrequencyHz: null,
  });
  const lastRadioSdrFrameRangeSignatureRef = useRef<string | null>(null);
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
  const [spectrumRecoveryState, setSpectrumRecoveryState] = useState<SpectrumRecoveryStateSnapshot>(SPECTRUM_RECOVERY_IDLE_STATE);
  const spectrumRecoveryStateRef = useRef<SpectrumRecoveryStateSnapshot>(SPECTRUM_RECOVERY_IDLE_STATE);
  useEffect(() => {
    onCollapsedChange?.(isCollapsed);
  }, [isCollapsed, onCollapsedChange]);
  const updateSpectrumRecoveryState = useCallback((nextState: SpectrumRecoveryStateSnapshot) => {
    if (areSpectrumRecoveryStatesEqual(spectrumRecoveryStateRef.current, nextState)) {
      return;
    }
    spectrumRecoveryStateRef.current = nextState;
    setSpectrumRecoveryState(nextState);
  }, []);
  const resetSpectrumRecoveryState = useCallback(() => {
    updateSpectrumRecoveryState(SPECTRUM_RECOVERY_IDLE_STATE);
  }, [updateSpectrumRecoveryState]);
  const handleActualRangeChange = useCallback((range: { min: number; max: number } | null) => {
    actualRangeRef.current = range;
  }, []);

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

  // 虚拟频差弱警告：判定逻辑放在独立的 FakeFreqLowPowerWatcher 中订阅高频 meterData，
  // 仅当结果集变化时才回写到这里，避免每次 meter 刷新都重渲染整个频谱子树。
  const fakeFrequencySupported = isFakeFrequencySupportedMode(engineMode, currentMode?.name);
  const fakeFrequencyEnabled = radioConnection.radioConfig?.fakeFrequency?.enabled ?? false;
  // 仅内存态：刷新网页后重置，会再次提示（不持久化到 localStorage）
  const [lowPowerHintDismissed, setLowPowerHintDismissed] = useState<boolean>(false);
  const [lowPowerWarningOperatorIds, setLowPowerWarningOperatorIds] = useState<string[]>([]);

  const handleEnableFakeFrequency = useCallback(() => {
    void api.setFakeFrequency(true).catch((error) => {
      logger.error('Failed to enable fake frequency from low-power hint', error);
    });
  }, []);
  const handleDismissLowPowerHint = useCallback(() => {
    setLowPowerHintDismissed(true);
  }, []);
  const effectiveSelectedKind = selectedKind ?? capabilities?.defaultKind ?? AUDIO_SOURCE;
  const activeSpectrumKind = subscribedKind ?? effectiveSelectedKind;
  const renderHistoryRows = resolveSpectrumHistoryRows(effectiveSelectedKind, height);
  const isAudioSpectrumSelected = effectiveSelectedKind === AUDIO_SOURCE;
  const isRadioSdrSelected = effectiveSelectedKind === RADIO_SDR_SOURCE;
  const isTciRadioSdr = isRadioSdrSelected && radioConnection.radioConfig?.type === 'tci';
  const isOpenWebRXSdrSelected = effectiveSelectedKind === OPENWEBRX_SDR_SOURCE;
  const canConfigureTciSpectrum = isTciRadioSdr && canControlRadio;
  useEffect(() => {
    if (!canConfigureTciSpectrum) {
      setTciSpectrumSettings(null);
      return;
    }
    let active = true;
    void api.getTciSpectrumSettings().then((response) => {
      if (active) setTciSpectrumSettings(response.settings);
    }).catch((error) => {
      logger.warn('Failed to load TCI spectrum settings', error);
      if (active) setTciSpectrumSettings(null);
    });
    return () => {
      active = false;
    };
  }, [canConfigureTciSpectrum]);
  const visualFrequencyOffsetHz = isAudioSpectrumSelected
    ? WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ
    : 0;
  const engineNotStarted = isSpectrumEngineNotStarted({
    connectionReady: connection.state.isReady,
    isEngineRunning,
    engineState,
  });
  const radioSdrTransmitPaused = isRadioSdrSelected && isTransmitting;
  const pauseNoFrameRecovery = shouldPauseSpectrumNoFrameRecovery({
    connectionReady: connection.state.isReady,
    selectedKind: effectiveSelectedKind,
    isTransmitting,
    isEngineRunning,
    engineState,
  });
  const isVoiceMode = engineMode === 'voice';
  const isCwMode = engineMode === 'cw';
  const isTciDigitalMode = isTciRadioSdr && engineMode === 'digital'
    && (currentMode?.name === 'FT8' || currentMode?.name === 'FT4');
  const sourceMode = sessionState?.sourceMode ?? 'unknown';
  const isFixedSpectrumMode = sourceMode === 'fixed' || sourceMode === 'scroll-fixed';
  const isOpenWebRXDetailMode = isOpenWebRXSdrSelected && sourceMode === 'detail';
  const spectrumViewMode = sessionState?.interaction.viewMode ?? (isTciRadioSdr ? 'wide' : 'radio-center');
  const viewportInteraction = sessionState?.interaction.viewport ?? {
    enabled: isTciRadioSdr,
    canZoom: isTciRadioSdr,
    canPan: isTciRadioSdr,
    canTuneAtEdge: isTciRadioSdr,
    bounds: null,
  };
  const isWideRadioSdr = isRadioSdrSelected && spectrumViewMode === 'wide' && viewportInteraction.enabled;
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
  // The logical operating-state frequency is the first signal of a normal
  // VFO/band switch; physical readback and session state can arrive later or
  // temporarily disagree. Prefer the requested VFO value so the local
  // absolute viewport is reset before the next frame is cropped.
  const baseRadioSdrFrequency = operatingState?.frequency
    ?? currentRadioFrequency
    ?? sessionState?.currentRadioFrequency
    ?? null;
  baseRadioSdrFrequencyRef.current = baseRadioSdrFrequency;
  radioServiceRef.current = connection.state.radioService;
  hasActiveSpectrumSubscriptionRef.current = connection.state.isConnected && !isCollapsed && Boolean(subscribedKind);
  const effectiveRadioSdrFrequency = isRadioSdrSelected && !isFixedSpectrumMode
    ? resolveRadioSdrOptimisticDisplayFrequencyHz(radioSdrOptimisticDisplayState, baseRadioSdrFrequency)
    : baseRadioSdrFrequency;
  const radioSdrNativeRange = streamStatus.fullRange;
  const radioSdrDisplayRange = streamStatus.displayRange;
  // The session capability is refreshed on a slower cadence than IQ frames.
  // Prefer the latest native frame range so edge tuning never uses stale bounds.
  const radioSdrViewportBounds = radioSdrNativeRange ?? viewportInteraction.bounds;
  useEffect(() => {
    if (!isWideRadioSdr) {
      previousWideRadioFrequencyRef.current = null;
      pendingWideRadioFrequencyChangeRef.current = null;
      previousWideNativeRangeRef.current = null;
      return;
    }

    const nextFrequency = baseRadioSdrFrequency;
    const previousFrequency = previousWideRadioFrequencyRef.current;
    previousWideRadioFrequencyRef.current = nextFrequency;
    if (
      typeof nextFrequency !== 'number'
      || !Number.isFinite(nextFrequency)
      || typeof previousFrequency !== 'number'
      || !Number.isFinite(previousFrequency)
      || Math.abs(nextFrequency - previousFrequency) < 1
    ) {
      return;
    }

    // A normal VFO/carrier change is distinct from TCI DDS edge tuning:
    // DDS moves the IQ center while `currentRadioFrequency` stays put. Mark
    // only the former so a cross-band switch recenters the local absolute
    // viewport instead of cropping the new frame with the old band's range.
    pendingWideRadioFrequencyChangeRef.current = {
      previous: previousFrequency,
      next: nextFrequency,
    };
    lastTciViewportTuneRef.current = null;
  }, [baseRadioSdrFrequency, isWideRadioSdr]);
  useEffect(() => {
    if (!isWideRadioSdr) {
      setRadioSdrViewport(null);
      tciDdsTuneRef.current.pendingFrequencyHz = null;
      connection.state.radioService?.setSpectrumViewport(null);
      pendingTciViewportRef.current = null;
      if (tciViewportSyncTimerRef.current) {
        clearTimeout(tciViewportSyncTimerRef.current);
        tciViewportSyncTimerRef.current = null;
      }
      lastTciViewportTuneRef.current = null;
      return;
    }
    if (!radioSdrNativeRange) {
      previousWideNativeRangeRef.current = null;
      return;
    }
    const previousNativeRange = previousWideNativeRangeRef.current;
    previousWideNativeRangeRef.current = { ...radioSdrNativeRange };
    const pendingFrequencyChange = pendingWideRadioFrequencyChangeRef.current;
    const shouldResetForFrequencySwitch = Boolean(
      pendingFrequencyChange
      && shouldResetWideRadioViewportForFrequencyChange({
        previousFrequency: pendingFrequencyChange.previous,
        nextFrequency: pendingFrequencyChange.next,
        previousNativeRange: previousNativeRange
          ? { min: previousNativeRange.min, max: previousNativeRange.max }
          : null,
        nextNativeRange: { min: radioSdrNativeRange.min, max: radioSdrNativeRange.max },
        currentViewport: radioSdrViewport,
        ddsTuneActive: tciDdsTuneRef.current.inFlight || tciDdsTuneRef.current.pendingFrequencyHz !== null,
      }),
    );
    const initialRange = radioSdrDisplayRange
      && radioSdrDisplayRange.max > radioSdrNativeRange.min
      && radioSdrDisplayRange.min < radioSdrNativeRange.max
      ? radioSdrDisplayRange
      : radioSdrNativeRange;
    if (shouldResetForFrequencySwitch) {
      pendingWideRadioFrequencyChangeRef.current = null;
      logger.debug('TCI viewport reset after radio frequency change', {
        rangeMinHz: initialRange.min,
        rangeMaxHz: initialRange.max,
      });
    } else if (
      pendingFrequencyChange
      && Math.abs(pendingFrequencyChange.next - pendingFrequencyChange.previous) < WIDE_RADIO_VIEWPORT_FREQUENCY_CHANGE_THRESHOLD_HZ
      && (!radioSdrViewport
        || (radioSdrViewport.max > radioSdrNativeRange.min && radioSdrViewport.min < radioSdrNativeRange.max))
    ) {
      // A small same-band retune that still has coverage does not need to
      // discard the user's zoomed viewport; clear the pending switch marker
      // so a later DDS envelope change cannot trigger a false reset.
      pendingWideRadioFrequencyChangeRef.current = null;
    }
    setRadioSdrViewport((current) => {
      const nativeSpan = radioSdrNativeRange.max - radioSdrNativeRange.min;
      if (!current || current.max <= current.min || shouldResetForFrequencySwitch) {
        return { ...initialRange };
      }
      const span = Math.min(nativeSpan, Math.max(TCI_MIN_LOCAL_VIEWPORT_SPAN_HZ, current.max - current.min));
      // The viewport is an absolute user selection. A new IQ/DDS center only
      // changes which samples cover that range; it must not translate the
      // viewport or clamp it back to the native envelope.
      return current.max - current.min === span
        ? current
        : { min: current.min, max: current.min + span };
    });
  }, [baseRadioSdrFrequency, connection.state.radioService, isWideRadioSdr, radioSdrDisplayRange?.max, radioSdrDisplayRange?.min, radioSdrNativeRange?.max, radioSdrNativeRange?.min, radioSdrViewport]);
  useEffect(() => () => {
    if (tciViewportSyncTimerRef.current) clearTimeout(tciViewportSyncTimerRef.current);
  }, []);
  const spectrumReferenceFrequency = isRadioSdrSelected
    ? effectiveRadioSdrFrequency
    : null;
  const radioSdrLevel = isRadioSdrSelected ? (streamStatus.level ?? RAW_RADIO_SDR_LEVEL) : null;
  const radioSdrLevelDomain: SpectrumLevelDomain = radioSdrLevel?.domain ?? 'raw';
  const radioSdrLevelUnit = radioSdrLevel?.unit ?? 'Level';
  useEffect(() => {
    actualRangeRef.current = null;
  }, [radioSdrLevelDomain]);
  const frequencyAxisTransform = React.useMemo(
    () => (isRadioSdrSelected
      && !isTciRadioSdr
      && typeof spectrumReferenceFrequency === 'number'
      && Number.isFinite(spectrumReferenceFrequency)
      ? createFrequencyAxisTransform(ICOM_RADIO_SDR_FREQUENCY_AXIS_CALIBRATION, spectrumReferenceFrequency)
      : IDENTITY_FREQUENCY_AXIS_TRANSFORM),
    [isRadioSdrSelected, isTciRadioSdr, spectrumReferenceFrequency],
  );
  const radioSdrRangeLimits = radioSdrLevel
    ? {
        min: Number.isFinite(radioSdrLevel.min) ? radioSdrLevel.min : RADIO_SDR_RANGE_LIMITS[radioSdrLevelDomain].min,
        max: Number.isFinite(radioSdrLevel.max) ? radioSdrLevel.max : RADIO_SDR_RANGE_LIMITS[radioSdrLevelDomain].max,
      }
    : RADIO_SDR_RANGE_LIMITS.raw;
  const currentManualRangeSettings = isOpenWebRXSdrSelected
    ? (isOpenWebRXDetailMode
        ? persistedRangeSettings.openWebRxSdr.detail
        : persistedRangeSettings.openWebRxSdr.full)
    : isRadioSdrSelected
      ? constrainManualRangeSettings(
          persistedRangeSettings.radioSdr[radioSdrLevelDomain],
          radioSdrRangeLimits,
        )
      : persistedRangeSettings.audio.manual;
  const selectedSpectrumThemeId = persistedRangeSettings.themeId;
  const showCycleMarkers = persistedRangeSettings.showCycleMarkers;
  const radioSdrCenterViewMode = persistedRangeSettings.radioSdrCenterViewMode;
  const showRadioSdrCenterViewSettings = canShowRadioSdrCenterViewSetting({
    isRadioSdrSelected,
    frequencyRangeMode,
    viewMode: spectrumViewMode,
  });
  const radioSdrCenterViewContext = React.useMemo(() => resolveRadioSdrCenterViewContext({
    isRadioSdrSelected,
    frequencyRangeMode,
    viewMode: spectrumViewMode,
    centerViewMode: radioSdrCenterViewMode,
    referenceFrequencyHz: spectrumReferenceFrequency,
  }), [frequencyRangeMode, isRadioSdrSelected, radioSdrCenterViewMode, spectrumReferenceFrequency, spectrumViewMode]);
  const cycleSlotMs = currentMode?.slotMs ?? null;
  const waterfallViewKey = `${effectiveSelectedKind}:${isOpenWebRXDetailMode ? 'detail' : 'main'}:${isRadioSdrSelected ? radioSdrLevelDomain : ''}:${spectrumRenderConfig?.revision ?? 0}`;
  const audioRangeSettings = persistedRangeSettings.audio;
  const rangeLimits = isOpenWebRXSdrSelected
    ? OPENWEBRX_RANGE_LIMITS
      : isRadioSdrSelected
      ? radioSdrRangeLimits
      : AUDIO_RANGE_LIMITS;
  const spectrumLevelUnit = isRadioSdrSelected ? radioSdrLevelUnit : 'dB';
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
          radioSdr: {
            ...prev.radioSdr,
            [radioSdrLevelDomain]: updater(prev.radioSdr[radioSdrLevelDomain]),
          },
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
  }, [isOpenWebRXDetailMode, isOpenWebRXSdrSelected, isRadioSdrSelected, radioSdrLevelDomain]);

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

  const handleSpectrumPresetChange = useCallback(async (preset: Exclude<SpectrumPreset, 'custom'>) => {
    if (!canConfigureSpectrum || spectrumPresetPending || spectrumRenderConfig?.preset === preset) {
      return;
    }

    setSpectrumPresetPending(true);
    try {
      await api.updateSpectrumSettings({ preset });
    } catch (error) {
      logger.error('Failed to update spectrum analysis preset', error);
      addToast({
        title: t('spectrum.analysisPresetUpdateFailed'),
        color: 'danger',
      });
    } finally {
      setSpectrumPresetPending(false);
    }
  }, [canConfigureSpectrum, spectrumPresetPending, spectrumRenderConfig?.preset, t]);

  const handleCustomSpectrumSettingsApply = useCallback(async (settings: SpectrumCustomSettings) => {
    if (!canConfigureSpectrum || spectrumPresetPending) {
      return;
    }

    setSpectrumPresetPending(true);
    try {
      await api.updateSpectrumSettings({ preset: 'custom', settings });
    } catch (error) {
      logger.error('Failed to update custom spectrum analysis settings', error);
      addToast({
        title: t('spectrum.analysisPresetUpdateFailed'),
        color: 'danger',
      });
    } finally {
      setSpectrumPresetPending(false);
    }
  }, [canConfigureSpectrum, spectrumPresetPending, t]);

  const handleCustomSpectrumCancel = useCallback(() => {
    setCustomSpectrumDraft(deriveSpectrumCustomSettings(spectrumRenderConfig));
    setCustomSpectrumEditing(spectrumRenderConfig?.preset === 'custom');
  }, [spectrumRenderConfig]);

  const handleTciSpectrumSettingsChange = useCallback(async (settings: TciSpectrumSettings) => {
    if (!canConfigureTciSpectrum || tciSpectrumSettingsPending) return;
    setTciSpectrumSettingsPending(true);
    try {
      const response = await api.updateTciSpectrumSettings(settings);
      setTciSpectrumSettings(response.settings);
    } catch (error) {
      logger.error('Failed to update TCI spectrum settings', error);
      addToast({ title: t('radio:spectrum.tciSettings.updateFailed'), color: 'danger' });
    } finally {
      setTciSpectrumSettingsPending(false);
    }
  }, [canConfigureTciSpectrum, t, tciSpectrumSettingsPending]);

  const handleCycleMarkersChange = useCallback((enabled: boolean) => {
    setPersistedRangeSettings(prev => ({
      ...prev,
      showCycleMarkers: enabled,
    }));
  }, []);

  const handleRadioSdrCenterViewModeChange = useCallback((mode: RadioSdrCenterViewMode) => {
    setPersistedRangeSettings(prev => ({
      ...prev,
      radioSdrCenterViewMode: mode,
    }));
  }, []);

  useEffect(() => {
    if (!spectrumRenderConfig) {
      streamController.setFrameIntervalMs(null);
      return;
    }
    setCustomSpectrumDraft(deriveSpectrumCustomSettings(spectrumRenderConfig));
    setCustomSpectrumEditing(spectrumRenderConfig.preset === 'custom');
    streamController.setFrameIntervalMs(spectrumRenderConfig.analysisIntervalMs);
    streamController.resetKind(AUDIO_SOURCE);
  }, [spectrumRenderConfig?.analysisIntervalMs, spectrumRenderConfig?.revision, streamController]);

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
      // Only forward finite reports; omit unset so a frequency drag cannot
      // re-inject a missing/sentinel report into the runtime.
      ...(typeof operator.context.reportSent === 'number' && Number.isFinite(operator.context.reportSent)
        ? { reportSent: operator.context.reportSent }
        : {}),
      ...(typeof operator.context.reportReceived === 'number' && Number.isFinite(operator.context.reportReceived)
        ? { reportReceived: operator.context.reportReceived }
        : {}),
    });
  }, [connection.state.radioService, operators]);

  const handleStrategyFrequencyPick = useCallback((frequency: number) => {
    if (!strategyFrequencyPick) return;
    connection.state.radioService?.invokeOperatorStrategyAction(
      strategyFrequencyPick.operatorId,
      strategyFrequencyPick.target,
      strategyFrequencyPick.actionId,
      { value: Math.round(frequency) },
    );
    setStrategyFrequencyPick(null);
  }, [connection.state.radioService, strategyFrequencyPick]);

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
      radioMode: currentMode?.name,
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
  }, [canWriteFrequency, canWriteTargetFrequency, connection.state.isConnected, currentMode?.name, engineMode, frequencyGestureStepHz, frequencyGestureTarget, resetOperatorsAfterOperatingStateChange, t]);

  const handleDigitalBaseFrequencyGesture = useCallback(async (frequency: number) => {
    if (!connection.state.isConnected || !canWriteFrequency || !Number.isFinite(frequency)) return;
    const roundedFrequency = Math.round(frequency);
    if (!canWriteTargetFrequency(roundedFrequency)) return;

    // A digital overlay drag is an intentional frequency gesture. Suppress
    // the follow-up auto-zoom for this one frequency transition so the user's
    // chosen viewport is not replaced by the FT8/FT4 presentation animation.
    if (isTciDigitalMode) {
      tciDigitalAutoZoomManualIntentRef.current = {
        frequencyHz: roundedFrequency,
        expiresAt: Date.now() + TCI_DIGITAL_AUTO_ZOOM_MANUAL_INTENT_TTL_MS,
      };
      if (tciDigitalAutoZoomTimerRef.current) {
        clearTimeout(tciDigitalAutoZoomTimerRef.current);
        tciDigitalAutoZoomTimerRef.current = null;
      }
      tciDigitalAutoZoomScheduledKeyRef.current = buildTciDigitalAutoZoomKey(
        currentMode?.name ?? null,
        tciDigitalAutoZoomFrequencyRef.current,
      );
    }
    try {
      const response = await setRadioFrequencyWithIntent({
        frequency: roundedFrequency,
        band: getBandFromFrequency(roundedFrequency),
        description: `${formatFrequencyMHz(roundedFrequency)} MHz`,
      });
      if (response.success) {
        resetOperatorsAfterOperatingStateChange();
      } else if (tciDigitalAutoZoomManualIntentRef.current?.frequencyHz === roundedFrequency) {
        tciDigitalAutoZoomManualIntentRef.current = null;
      }
    } catch (error) {
      if (tciDigitalAutoZoomManualIntentRef.current?.frequencyHz === roundedFrequency) {
        tciDigitalAutoZoomManualIntentRef.current = null;
      }
      logger.error('Failed to set digital base frequency from SDR overlay', error);
    }
  }, [canWriteFrequency, canWriteTargetFrequency, connection.state.isConnected, currentMode?.name, isTciDigitalMode, resetOperatorsAfterOperatingStateChange]);

  const queueTciViewportSync = useCallback((range: { min: number; max: number }) => {
    pendingTciViewportRef.current = {
      min: range.min,
      max: range.max,
      displayBinCount: TCI_CLIENT_VIEWPORT_DISPLAY_BINS,
    };
    if (!tciViewportSyncTimerRef.current) {
      tciViewportSyncTimerRef.current = setTimeout(() => {
        tciViewportSyncTimerRef.current = null;
        const viewport = pendingTciViewportRef.current;
        pendingTciViewportRef.current = null;
        if (viewport) {
          logger.debug('TCI spectrum viewport sent', { minHz: viewport.min, maxHz: viewport.max, displayBinCount: viewport.displayBinCount });
          connection.state.radioService?.setSpectrumViewport(viewport);
        }
      }, TCI_VIEWPORT_SYNC_DEBOUNCE_MS);
    }
  }, [connection.state.radioService]);

  // `radioSdrViewport` is the single owner of the committed client view.
  // Synchronize every committed state transition here so initial/default
  // ranges, automatic FT8/FT4 zoom, frequency-switch resets, buttons, and
  // gesture commits all negotiate the same high-resolution server projection.
  // GPU preview gestures do not update this state and therefore remain local.
  useEffect(() => {
    if (!isWideRadioSdr || !radioSdrViewport) return;
    queueTciViewportSync(radioSdrViewport);
  }, [isWideRadioSdr, queueTciViewportSync, radioSdrViewport]);

  const flushTciDdsTune = useCallback(async () => {
    const queue = tciDdsTuneRef.current;
    if (queue.inFlight || queue.pendingFrequencyHz === null) return;
    const radioService = connection.state.radioService;
    if (!radioService) {
      queue.pendingFrequencyHz = null;
      return;
    }

    const targetFrequencyHz = queue.pendingFrequencyHz;
    queue.pendingFrequencyHz = null;
    queue.inFlight = true;
    logger.info('TCI DDS edge tune started', { targetFrequencyHz });
    try {
      await radioService.setRadioDdsFrequency(targetFrequencyHz);
      logger.info('TCI DDS edge tune completed', { targetFrequencyHz });
    } catch (error) {
      logger.warn('TCI DDS edge tune failed', { targetFrequencyHz, error: error instanceof Error ? error.message : String(error) });
    } finally {
      queue.inFlight = false;
      if (queue.pendingFrequencyHz !== null) {
        void flushTciDdsTune();
      }
    }
  }, [connection.state.radioService]);

  const queueTciDdsTune = useCallback((frequencyHz: number) => {
    if (!Number.isFinite(frequencyHz)) return;
    const queue = tciDdsTuneRef.current;
    const targetFrequencyHz = Math.round(frequencyHz);
    if (queue.pendingFrequencyHz === targetFrequencyHz && queue.inFlight) return;
    queue.pendingFrequencyHz = targetFrequencyHz;
    logger.debug('TCI DDS edge tune queued', { targetFrequencyHz, inFlight: queue.inFlight });
    void flushTciDdsTune();
  }, [flushTciDdsTune]);

  const handleTciViewportChange = useCallback((next: { min: number; max: number }, source: 'pan' | 'zoom', phase: 'preview' | 'commit' = 'commit'): { min: number; max: number } | void => {
    if (!isWideRadioSdr || !radioSdrViewportBounds) return;
    if (tciDigitalAutoZoomTimerRef.current) {
      clearTimeout(tciDigitalAutoZoomTimerRef.current);
      tciDigitalAutoZoomTimerRef.current = null;
    }
    // A manual viewport gesture completes the current presentation cycle. It
    // must not suppress a later radio-frequency generation.
    tciDigitalAutoZoomScheduledKeyRef.current = buildTciDigitalAutoZoomKey(
      currentMode?.name ?? null,
      tciDigitalAutoZoomFrequencyRef.current,
    );
    const nativeSpan = radioSdrViewportBounds.max - radioSdrViewportBounds.min;
    if (!Number.isFinite(nativeSpan) || nativeSpan <= 0) return;
    const requestedSpan = Math.min(nativeSpan, Math.max(TCI_MIN_LOCAL_VIEWPORT_SPAN_HZ, next.max - next.min));
    let center = (next.min + next.max) / 2;
    const half = requestedSpan / 2;
    const outOfBounds = center - half < radioSdrViewportBounds.min || center + half > radioSdrViewportBounds.max;
    const canTuneAtEdge = viewportInteraction.canTuneAtEdge && canWriteFrequency;
    // Preview callbacks run on every pointer/wheel packet. Keep the hot path
    // allocation-free; the committed range and DDS queue already emit the
    // structured diagnostics needed to reconstruct a gesture.
    if (phase !== 'preview') {
      logger.debug('TCI spectrum viewport gesture committed', {
        source,
        requestedMinHz: next.min,
        requestedMaxHz: next.max,
        requestedCenterHz: center,
        requestedSpanHz: requestedSpan,
        nativeMinHz: radioSdrViewportBounds.min,
        nativeMaxHz: radioSdrViewportBounds.max,
        outOfBounds,
        canTuneAtEdge,
      });
    }
    if (source === 'pan' && outOfBounds && canTuneAtEdge) {
      const tunedCenter = Math.round(center);
      const tuneStep = isCwMode ? 10 : 1000;
      if (lastTciViewportTuneRef.current === null || Math.abs(tunedCenter - lastTciViewportTuneRef.current) >= tuneStep) {
        lastTciViewportTuneRef.current = tunedCenter;
        queueTciDdsTune(tunedCenter);
      }
    }
    if (source === 'zoom' || (source === 'pan' && outOfBounds && !canTuneAtEdge)) {
      center = Math.max(radioSdrViewportBounds.min + half, Math.min(radioSdrViewportBounds.max - half, center));
    }
    const nextRange = { min: center - half, max: center + half };
    // Preview changes are rendered GPU-side by the waterfall. Neither React
    // state nor the server viewport is updated mid-gesture: the server
    // would reproject frames to the stale preview range with one round-trip
    // of lag and erode the frozen texture edges. The gesture-end commit
    // performs the single state update and viewport upload.
    if (phase !== 'preview') {
      setRadioSdrViewport(nextRange);
    }
    return nextRange;
  }, [canWriteFrequency, currentMode?.name, isCwMode, isWideRadioSdr, queueTciDdsTune, radioSdrViewportBounds, viewportInteraction.canTuneAtEdge]);

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
      tciDdsTuneRef.current.pendingFrequencyHz = null;
      if (hasActiveSpectrumSubscriptionRef.current) {
        radioServiceRef.current?.subscribeSpectrum(null);
      }
      radioServiceRef.current?.setSpectrumViewport(null);
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
    if (isCollapsed || !connection.state.isConnected || !subscribedKind) {
      return;
    }

    connection.state.radioService?.subscribeSpectrum(subscribedKind);
  }, [connection.state.isConnected, connection.state.radioService, isCollapsed, subscribedKind]);

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
      if (
        frame.kind === AUDIO_SOURCE
        && spectrumRenderConfig
        && frame.meta.spectrumConfigRevision !== undefined
        && frame.meta.spectrumConfigRevision !== spectrumRenderConfig.revision
      ) {
        return;
      }
      if (frame.kind === RADIO_SDR_SOURCE) {
        const nativeRange = frame.meta.nativeFrequencyRange ?? frame.frequencyRange;
        const signature = `${frame.frequencyRange.min}:${frame.frequencyRange.max}:${nativeRange.min}:${nativeRange.max}:${frame.meta.displayBinCount ?? frame.binaryData.format.length}`;
        if (signature !== lastRadioSdrFrameRangeSignatureRef.current) {
          lastRadioSdrFrameRangeSignatureRef.current = signature;
          logger.debug('TCI spectrum frame range received', {
            frequencyRange: frame.frequencyRange,
            nativeFrequencyRange: nativeRange,
            displayBinCount: frame.meta.displayBinCount ?? frame.binaryData.format.length,
            timestamp: frame.timestamp,
          });
        }
      }
      streamController.pushFrame(frame);
      if (frame.kind === activeSpectrumKind) {
        lastAcceptedSpectrumFrameAtRef.current = Date.now();
        spectrumNoFrameRetryCountRef.current = 0;
        updateSpectrumRecoveryState(resolveSpectrumRecoveryStateAfterFrame(spectrumRecoveryStateRef.current));
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
  }, [activeProfileId, activeSpectrumKind, connection.state.radioService, isCollapsed, isRadioSdrServerFrequencySyncHeld, spectrumRenderConfig, streamController, updateRadioSdrOptimisticDisplayState, updateSpectrumRecoveryState]);

  useEffect(() => {
    lastAcceptedSpectrumFrameAtRef.current = Date.now();
    spectrumNoFrameRetryCountRef.current = 0;
    resetSpectrumRecoveryState();

    if (isCollapsed || pauseNoFrameRecovery || !connection.state.isReady || !connection.state.radioService || !subscribedKind) {
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
        updateSpectrumRecoveryState({
          isStale: true,
          retryCount: nextRetryCount,
          exhausted: false,
        });
        connection.state.radioService?.retrySpectrumSubscription('no-frame-timeout');
        return;
      }

      updateSpectrumRecoveryState({
        isStale: true,
        retryCount: spectrumNoFrameRetryCountRef.current,
        exhausted: true,
      });
    }, SPECTRUM_NO_FRAME_CHECK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [connection.state.isReady, connection.state.radioService, isCollapsed, pauseNoFrameRecovery, resetSpectrumRecoveryState, subscribedKind, updateSpectrumRecoveryState]);

  useLayoutEffect(() => {
    const axisTransition = spectrumViewportTransitionRef.current ? 'animate' as const : 'immediate' as const;
    spectrumViewportTransitionRef.current = false;
    streamController.updateContext({
      selectedKind: effectiveSelectedKind,
      openWebRXViewport: isOpenWebRXSdrSelected && !isOpenWebRXDetailMode ? openWebRXViewport : null,
      isOpenWebRXDetailMode,
      radioSdrCenterViewMode: radioSdrCenterViewContext.centerViewMode,
      radioSdrReferenceFrequencyHz: radioSdrCenterViewContext.referenceFrequencyHz,
      radioSdrViewport: isWideRadioSdr ? radioSdrViewport : null,
    }, { axisTransition });
  }, [
    effectiveSelectedKind,
    isOpenWebRXDetailMode,
    isOpenWebRXSdrSelected,
    openWebRXViewport,
    radioSdrCenterViewContext,
    radioSdrViewport,
    isWideRadioSdr,
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
    actualRangeRef.current = null;
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
      radioSdrCenterViewMode: normalizeRadioSdrCenterViewMode(prev.radioSdrCenterViewMode),
      radioSdr: normalizeRadioSdrRangeSettings(prev.radioSdr),
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
  const radioSdrFrequencyOverlays = React.useMemo(() => (
    (sessionState?.interaction.frequencyOverlays ?? []).map(mapSessionFrequencyOverlay)
  ), [sessionState?.interaction.frequencyOverlays]);
  const tciDigitalRxOverlay = React.useMemo(() => (
    sessionState?.interaction.frequencyOverlays?.find((overlay) => (
      overlay.id === 'digital-usb-window'
      && overlay.frequencyTarget === 'radio-frequency'
      && Number.isFinite(overlay.rangeStartFrequency)
      && Number.isFinite(overlay.rangeEndFrequency)
      && overlay.rangeEndFrequency > overlay.rangeStartFrequency
    )) ?? null
  ), [sessionState?.interaction.frequencyOverlays]);
  tciDigitalAutoZoomFrequencyRef.current = typeof baseRadioSdrFrequency === 'number' && Number.isFinite(baseRadioSdrFrequency)
    ? baseRadioSdrFrequency
    : (tciDigitalRxOverlay?.lineFrequency ?? null);
  useEffect(() => {
    const modeName = currentMode?.name ?? null;
    const autoZoomFrequency = typeof baseRadioSdrFrequency === 'number' && Number.isFinite(baseRadioSdrFrequency)
      ? baseRadioSdrFrequency
      : (tciDigitalRxOverlay?.lineFrequency ?? null);
    const autoZoomKey = buildTciDigitalAutoZoomKey(modeName, autoZoomFrequency);
    if (
      !isTciDigitalMode
      || !isWideRadioSdr
      || !autoZoomKey
    ) {
      if (tciDigitalAutoZoomTimerRef.current) {
        clearTimeout(tciDigitalAutoZoomTimerRef.current);
        tciDigitalAutoZoomTimerRef.current = null;
      }
      tciDigitalAutoZoomScheduledKeyRef.current = null;
      tciDigitalAutoZoomManualIntentRef.current = null;
      tciDigitalAutoZoomWaitingKeyRef.current = null;
      return;
    }
    if (!radioSdrViewportBounds || !tciDigitalRxOverlay) {
      if (tciDigitalAutoZoomTimerRef.current) {
        clearTimeout(tciDigitalAutoZoomTimerRef.current);
        tciDigitalAutoZoomTimerRef.current = null;
      }
      tciDigitalAutoZoomScheduledKeyRef.current = null;
      return;
    }

    const manualIntent = tciDigitalAutoZoomManualIntentRef.current;
    const activeManualIntent = manualIntent && manualIntent.expiresAt > Date.now()
      ? manualIntent
      : null;
    if (manualIntent && !activeManualIntent) {
      tciDigitalAutoZoomManualIntentRef.current = null;
    }
    const isManualFrequencyChange = Boolean(
      activeManualIntent
      && Math.abs(activeManualIntent.frequencyHz - (autoZoomFrequency ?? Number.NaN))
        <= TCI_DIGITAL_AUTO_ZOOM_FREQUENCY_TOLERANCE_HZ,
    );
    if (isManualFrequencyChange) {
      tciDigitalAutoZoomManualIntentRef.current = null;
      tciDigitalAutoZoomScheduledKeyRef.current = autoZoomKey;
      logger.debug('TCI digital auto zoom skipped after manual overlay frequency change', {
        mode: modeName,
        frequencyHz: autoZoomFrequency,
      });
      return;
    }
    if (tciDigitalAutoZoomScheduledKeyRef.current === autoZoomKey) return;

    const fullRange = radioSdrViewportBounds;
    const targetRange = resolveTciDigitalAutoZoomTargetRange(
      fullRange,
      tciDigitalRxOverlay,
      baseRadioSdrFrequency,
    );
    // A frequency event can precede the new IQ envelope or the updated
    // session overlay. Wait for a range that can actually contain the target;
    // the numeric bounds/overlay dependencies below will retry this effect.
    if (!targetRange) {
      if (tciDigitalAutoZoomWaitingKeyRef.current !== autoZoomKey) {
        tciDigitalAutoZoomWaitingKeyRef.current = autoZoomKey;
        logger.debug('TCI digital auto zoom waiting for target range coverage', {
          mode: modeName,
          frequencyHz: autoZoomFrequency,
          boundsMinHz: fullRange.min,
          boundsMaxHz: fullRange.max,
          overlayLineHz: tciDigitalRxOverlay.lineFrequency,
          overlayMinHz: tciDigitalRxOverlay.rangeStartFrequency,
          overlayMaxHz: tciDigitalRxOverlay.rangeEndFrequency,
        });
      }
      return;
    }

    tciDigitalAutoZoomWaitingKeyRef.current = null;

    tciDigitalAutoZoomScheduledKeyRef.current = autoZoomKey;
    logger.debug('TCI digital auto zoom scheduled', {
      mode: modeName,
      frequencyHz: autoZoomFrequency,
      fullMinHz: fullRange.min,
      fullMaxHz: fullRange.max,
      targetMinHz: targetRange.min,
      targetMaxHz: targetRange.max,
    });
    setRadioSdrViewport((current) => (
      current
      && current.min === fullRange.min
      && current.max === fullRange.max
        ? current
        : { ...fullRange }
    ));

    tciDigitalAutoZoomTimerRef.current = setTimeout(() => {
      tciDigitalAutoZoomTimerRef.current = null;
      if (tciDigitalAutoZoomScheduledKeyRef.current !== autoZoomKey) return;
      spectrumViewportTransitionRef.current = true;
      setRadioSdrViewport((current) => (
        current
        && current.min === targetRange.min
        && current.max === targetRange.max
          ? current
          : targetRange
      ));
    }, TCI_DIGITAL_AUTO_ZOOM_DELAY_MS);

    return () => {
      if (tciDigitalAutoZoomTimerRef.current) {
        clearTimeout(tciDigitalAutoZoomTimerRef.current);
        tciDigitalAutoZoomTimerRef.current = null;
      }
    };
  }, [baseRadioSdrFrequency, currentMode?.name, isTciDigitalMode, isWideRadioSdr, radioSdrViewportBounds?.max, radioSdrViewportBounds?.min, tciDigitalRxOverlay?.lineFrequency, tciDigitalRxOverlay?.rangeEndFrequency, tciDigitalRxOverlay?.rangeStartFrequency]);
  const handleSplitFrequencyChange = useCallback((frequency: number) => {
    if (
      !canWriteFrequency
      || !splitTxFrequencyWritable
      || !Number.isFinite(frequency)
      || !connection.state.radioService
    ) return;
    connection.state.radioService.wsClientInstance.setSplitFrequency(Math.round(frequency));
  }, [canWriteFrequency, connection.state.radioService, splitTxFrequencyWritable]);
  const handleRadioSdrOverlayFrequencyChange = useCallback((id: string, frequency: number) => {
    const overlay = radioSdrFrequencyOverlays.find(item => item.id === id);
    if (!overlay?.draggable || !Number.isFinite(frequency)) return;
    if (overlay.frequencyTarget === 'split-frequency') {
      handleSplitFrequencyChange(frequency);
      return;
    }
    if (overlay.frequencyTarget !== 'radio-frequency') return;
    if (frequencyGestureTarget === 'radio-frequency') {
      void handleRadioSdrFrequencyGesture(frequency);
      return;
    }
    void handleDigitalBaseFrequencyGesture(frequency);
  }, [frequencyGestureTarget, handleDigitalBaseFrequencyGesture, handleRadioSdrFrequencyGesture, handleSplitFrequencyChange, radioSdrFrequencyOverlays]);
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
      setSubscribedKind(kind);
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

  const handleStepTciViewportZoom = useCallback((direction: 'in' | 'out') => {
    if (!isWideRadioSdr || !radioSdrViewport || !radioSdrViewportBounds || !viewportInteraction.canZoom) return;
    const nativeSpan = radioSdrViewportBounds.max - radioSdrViewportBounds.min;
    const currentSpan = radioSdrViewport.max - radioSdrViewport.min;
    if (!Number.isFinite(nativeSpan) || nativeSpan <= 0 || !Number.isFinite(currentSpan) || currentSpan <= 0) return;
    const nextSpan = Math.max(
      TCI_MIN_LOCAL_VIEWPORT_SPAN_HZ,
      Math.min(nativeSpan, currentSpan * (direction === 'in' ? 0.5 : 2)),
    );
    // Button zoom follows the actual operating frequency rather than the
    // current viewport midpoint. This keeps the active VFO in focus after a
    // user has panned away from it; optimistic frequency state covers a VFO
    // change that has not reached the physical readback yet.
    const center = typeof effectiveRadioSdrFrequency === 'number' && Number.isFinite(effectiveRadioSdrFrequency)
      ? effectiveRadioSdrFrequency
      : (radioSdrViewport.min + radioSdrViewport.max) / 2;
    const boundedCenter = Math.max(
      radioSdrViewportBounds.min + nextSpan / 2,
      Math.min(radioSdrViewportBounds.max - nextSpan / 2, center),
    );
    const nextRange = {
      min: boundedCenter - nextSpan / 2,
      max: boundedCenter + nextSpan / 2,
    };
    // Reuse the same WebGL axis transition used by the FT8/FT4 automatic
    // presentation zoom. The viewport remains client-local; this flag only
    // selects the visual transition for the next committed range.
    spectrumViewportTransitionRef.current = true;
    setRadioSdrViewport(nextRange);
  }, [effectiveRadioSdrFrequency, isWideRadioSdr, radioSdrViewport, radioSdrViewportBounds, viewportInteraction.canZoom]);

  const controls = sessionState?.controls ?? [];
  const spectrumZoomOutControl = controls.find(control => control.id === 'zoom-step' && control.action === 'out' && control.visible);
  const spectrumZoomInControl = controls.find(control => control.id === 'zoom-step' && control.action === 'in' && control.visible);
  const digitalWindowControl = controls.find(control => control.id === 'digital-window-toggle' && control.visible);
  const openWebRXDetailControl = controls.find(control => control.id === 'openwebrx-detail-toggle' && control.visible);
  const viewportZoomOutControl = controls.find(control => control.id === 'viewport-zoom' && control.action === 'out' && control.visible);
  const viewportZoomInControl = controls.find(control => control.id === 'viewport-zoom' && control.action === 'in' && control.visible);
  const canTciViewportZoomOut = isWideRadioSdr && viewportInteraction.canZoom && Boolean(radioSdrViewport && radioSdrViewportBounds)
    && (radioSdrViewport!.max - radioSdrViewport!.min) < (radioSdrViewportBounds!.max - radioSdrViewportBounds!.min);
  const canTciViewportZoomIn = isWideRadioSdr && viewportInteraction.canZoom && Boolean(radioSdrViewport)
    && (radioSdrViewport!.max - radioSdrViewport!.min) > TCI_MIN_LOCAL_VIEWPORT_SPAN_HZ;
  const shouldShowZoomControls = isWideRadioSdr
    ? Boolean(radioSdrViewport)
    : Boolean(spectrumZoomOutControl || spectrumZoomInControl);
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
              onPress={() => isWideRadioSdr ? handleStepTciViewportZoom('out') : handleInvokeSpectrumControl('zoom-step', 'out')}
              isDisabled={isWideRadioSdr ? !canTciViewportZoomOut : !spectrumZoomOutControl?.enabled}
              title={t('spectrum.zoomOut')}
            >
              <MinusIcon className="w-2.5 h-2.5" />
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="min-w-5 w-5 h-5 px-0 text-white/90 disabled:text-default-500"
              onPress={() => isWideRadioSdr ? handleStepTciViewportZoom('in') : handleInvokeSpectrumControl('zoom-step', 'in')}
              isDisabled={isWideRadioSdr ? !canTciViewportZoomIn : !spectrumZoomInControl?.enabled}
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

  const handleToggleInputSignal = useCallback(async () => {
    if (!canToggleInputSignal || inputSignalTogglePending) return;
    const nextType: AudioInputSignalType = isIfInputSignal ? 'af' : 'icom-12k-if';
    setInputSignalTogglePending(true);
    try {
      await api.updateAudioSettings({ inputSignalType: nextType });
      addToast({
        title: nextType === 'icom-12k-if'
          ? t('spectrum.inputSignalSwitchedToIf')
          : t('spectrum.inputSignalSwitchedToAf'),
        description: nextType === 'icom-12k-if'
          ? t('spectrum.inputSignalIfHint')
          : undefined,
        color: 'success',
      });
    } catch (error) {
      logger.error('Failed to toggle AF/IF input signal', error);
      addToast({
        title: t('spectrum.inputSignalToggleFailed'),
        color: 'danger',
      });
    } finally {
      setInputSignalTogglePending(false);
    }
  }, [canToggleInputSignal, inputSignalTogglePending, isIfInputSignal, t]);

  const inputSignalToggleRightClass = canPopOut ? 'right-[5.5rem]' : 'right-[3.75rem]';

  const renderInputSignalToggle = (rightClassName = inputSignalToggleRightClass) => {
    if (!canToggleInputSignal) return null;
    return (
      <Tooltip
        content={isIfInputSignal ? t('spectrum.inputSignalIfTooltip') : t('spectrum.inputSignalAfTooltip')}
        delay={250}
      >
        <Button
          size="sm"
          variant="light"
          onPress={() => { void handleToggleInputSignal(); }}
          isDisabled={inputSignalTogglePending}
          className={`absolute top-1 ${rightClassName} z-30 h-6 min-w-7 px-1.5 text-[11px] font-semibold tracking-wide ${
            isIfInputSignal
              ? 'bg-primary/25 text-primary-700 hover:bg-primary/35 dark:text-primary-300'
              : 'text-default-600 hover:bg-black/30 hover:text-default-900 dark:text-default-300 dark:hover:bg-white/15 dark:hover:text-default-50'
          }`}
          aria-label={isIfInputSignal ? t('spectrum.inputSignalIfTooltip') : t('spectrum.inputSignalAfTooltip')}
        >
          {isIfInputSignal ? t('spectrum.inputSignalIfLabel') : t('spectrum.inputSignalAfLabel')}
        </Button>
      </Tooltip>
    );
  };

  const waterfallViewportInteraction = useMemo(() => ({
    mode: isWideRadioSdr && !isFixedSpectrumMode
      ? 'local-pan-zoom' as const
      : isRadioSdrSelected
        ? 'radio-center' as const
        : 'none' as const,
    range: isWideRadioSdr && !isFixedSpectrumMode ? radioSdrViewport : null,
    bounds: isWideRadioSdr && !isFixedSpectrumMode ? radioSdrViewportBounds : null,
    canZoom: isWideRadioSdr && !isFixedSpectrumMode && viewportInteraction.canZoom,
    canPan: isWideRadioSdr && !isFixedSpectrumMode && viewportInteraction.canPan,
    onChange: isWideRadioSdr && !isFixedSpectrumMode ? handleTciViewportChange : undefined,
    supportsPreview: isWideRadioSdr && !isFixedSpectrumMode,
  }), [handleTciViewportChange, isFixedSpectrumMode, isRadioSdrSelected, isWideRadioSdr, radioSdrViewport, radioSdrViewportBounds, viewportInteraction.canPan, viewportInteraction.canZoom]);

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
    const emptyStatusKey = resolveSpectrumEmptyStatusKey({
      engineNotStarted,
      radioSdrTransmitPaused,
      recoveryState: spectrumRecoveryState,
    });
    const waitingText = emptyStatusKey === 'engineNotStarted'
      ? t('spectrum.engineNotStarted')
      : emptyStatusKey === 'transmittingPaused'
        ? t('spectrum.transmittingPaused')
        : emptyStatusKey === 'noData'
          ? t('spectrum.noData')
          : emptyStatusKey === 'retrying'
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
        {renderInputSignalToggle(canPopOut ? 'right-[3.75rem]' : 'right-8')}
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
      <FakeFreqLowPowerWatcher
        active={fakeFrequencySupported && canControlRadio && !fakeFrequencyEnabled && !lowPowerHintDismissed}
        onChange={setLowPowerWarningOperatorIds}
      />
      <SpectrumRenderHost
        key={waterfallViewKey}
        presentation={presentation}
        height={height}
        className="bg-transparent"
        waterfallProps={{
          controller: streamController,
          minDb: currentManualRangeSettings.minDb,
          maxDb: currentManualRangeSettings.maxDb,
          autoRange: !isRadioSdrSelected && !isOpenWebRXSdrSelected && audioRangeSettings.mode === 'auto',
          autoRangeConfig: audioRangeSettings.auto,
          themeId: selectedSpectrumThemeId,
          sharpPixels: isAudioSpectrumSelected && isIfInputSignal,
          frameIntervalMs: spectrumRenderConfig?.analysisIntervalMs,
          totalRows: renderHistoryRows,
          showCycleMarkers,
          cycleSlotMs,
          frequencyRangeMode,
          referenceFrequencyHz: spectrumReferenceFrequency,
          frequencyAxisTransform,
          visualFrequencyOffsetHz,
          basebandInteractionRange: BASEBAND_INTERACTION_RANGE,
          interactionFrequencyMode: frequencyGestureTarget === 'radio-frequency' ? 'absolute' : 'baseband',
          interactionFrequencyStepHz: frequencyGestureStepHz,
          viewportInteraction: waterfallViewportInteraction,
          dragFrequencyStepHz: radioSdrDragFrequencyStepHz,
          dragFrequencyCommitIntervalMs: RADIO_SDR_DRAG_FREQUENCY_COMMIT_INTERVAL_MS,
          txBandOverlays: radioSdrFrequencyOverlays,
          frequencyBandOverlays: isAudioSpectrumSelected ? frequencyBandOverlays : [],
          presetMarkers,
          rxFrequencies: displaySpectrumMarkers.rxFrequencies,
          txFrequencies: displaySpectrumMarkers.txFrequencies,
          lowPowerWarningOperatorIds,
          onEnableFakeFrequency: handleEnableFakeFrequency,
          onDismissLowPowerWarning: handleDismissLowPowerHint,
          onTxFrequencyChange: displayTxFrequencyChange,
          onTxBandOverlayFrequencyChange: canWriteFrequency ? handleRadioSdrOverlayFrequencyChange : undefined,
          onFrequencyBandOverlayPreviewChange: isAudioSpectrumSelected ? onFrequencyBandOverlayPreviewChange : undefined,
          onFrequencyBandOverlayCommit: isAudioSpectrumSelected ? onFrequencyBandOverlayCommit : undefined,
          onPresetMarkerClick: presetMarkers.length > 0 && canWriteFrequency && frequencyGestureTarget === 'radio-frequency' ? handleRadioFrequencyGesture : undefined,
          onDragFrequencyPreview: canDragRadioSdrFrequency ? handleRadioSdrFrequencyDragPreview : undefined,
          onDragFrequencyActiveChange: canDragRadioSdrFrequency ? handleRadioSdrDragActiveChange : undefined,
          enableHorizontalWheelFrequency: canDragRadioSdrFrequency,
          onDragFrequencyChange: canDragRadioSdrFrequency ? handleRadioSdrFrequencyDragCommit : undefined,
          onDoubleClickSetFrequency: strategyFrequencyPick && isAudioSpectrumSelected
            ? handleStrategyFrequencyPick
            : frequencyGestureTarget === 'radio-frequency' && canDoubleClickSetFrequency && canWriteFrequency
              ? handleRadioFrequencyGesture
              : undefined,
          onRightClickSetFrequency: isOpenWebRXSdrSelected
            ? (isOpenWebRXDetailMode ? handleRightClickSetFrequency : undefined)
            : frequencyGestureTarget === 'radio-frequency'
              ? (canRightClickSetFrequency && canWriteFrequency ? handleRadioFrequencyGesture : undefined)
              : (showMarkers && canRightClickSetFrequency ? handleRightClickSetFrequency : undefined),
          onActualRangeChange: handleActualRangeChange,
          hoverFrequency: effectiveHoverFrequency,
          isTransmitting,
          className: 'bg-transparent',
        }}
      />
      {spectrumRecoveryState.isStale && !pauseNoFrameRecovery && (
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

      {renderInputSignalToggle()}

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
        <PopoverContent className="w-[min(24rem,calc(100vw-1rem))] max-h-[calc(100dvh-3rem)] overflow-hidden p-0">
          <div className="flex max-h-[calc(100dvh-3rem)] w-full flex-col">
            <div className="z-10 shrink-0 bg-content1 px-4 py-3 text-sm font-semibold">
              {t('spectrum.rangeSettings')}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="space-y-3">
                <Accordion
                  variant="light"
                  selectionMode="multiple"
                  defaultExpandedKeys={new Set(['view', 'display'])}
                  className="-mx-1 -mt-3 gap-1 px-0"
                  itemClasses={{
                    base: 'border-b-0 py-0',
                    heading: 'border-b-0',
                    trigger: 'min-h-0 px-1 py-2',
                    title: 'text-xs font-medium text-default-600',
                    content: 'px-1 pb-3 pt-1',
                  }}
                >
                  <AccordionItem key="view" title={<span className="text-xs font-medium text-default-600">{t('spectrum.viewSettings')}</span>}>
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
                  </AccordionItem>
                {isAudioSpectrumSelected && canConfigureSpectrum && spectrumRenderConfig && (
                  <AccordionItem key="audio-analysis" title={<span className="text-xs font-medium text-default-600">{t('spectrum.analysisSettings')}</span>}>
                    <SpectrumAnalysisSettings
                      config={spectrumRenderConfig}
                      enabled={canConfigureSpectrum}
                      pending={spectrumPresetPending}
                      customDraft={customSpectrumDraft}
                      customEditing={customSpectrumEditing}
                      onPresetChange={handleSpectrumPresetChange}
                      onCustomEditingChange={setCustomSpectrumEditing}
                      onCustomDraftChange={setCustomSpectrumDraft}
                    />
                  </AccordionItem>
                )}
                {canConfigureTciSpectrum && tciSpectrumSettings && (
                  <AccordionItem key="tci-analysis" title={<span className="text-xs font-medium text-default-600">{t('radio:spectrum.tciSettings.title')}</span>}>
                    <TciSpectrumSettingsPanel
                      settings={tciSpectrumSettings}
                      pending={tciSpectrumSettingsPending}
                      canWrite={canConfigureTciSpectrum}
                      sampleRateState={tciIqSampleRateState}
                      sampleRateDescriptor={tciIqSampleRateDescriptor}
                      onCapabilityWrite={writeRadioCapability}
                      onChange={handleTciSpectrumSettingsChange}
                    />
                  </AccordionItem>
                )}
                <AccordionItem key="interaction" title={<span className="text-xs font-medium text-default-600">{t('spectrum.interactionSettings')}</span>}>
                <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-lg bg-default-100/50 px-2 py-2 dark:bg-default-50/10">
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
                {showRadioSdrCenterViewSettings && (
                  <div className="space-y-2 rounded-lg bg-default-100/50 px-2 py-2 dark:bg-default-50/10">
                    <div>
                      <div className="text-xs font-medium text-default-700">
                        {t('spectrum.radioSdrCenterView')}
                      </div>
                      <div className="text-[11px] leading-tight text-default-400">
                        {t('spectrum.radioSdrCenterViewDescription')}
                      </div>
                    </div>
                    <Tabs
                      selectedKey={radioSdrCenterViewMode}
                      onSelectionChange={(key) => handleRadioSdrCenterViewModeChange(normalizeRadioSdrCenterViewMode(key))}
                      fullWidth
                      size="sm"
                      classNames={{
                        base: 'w-full',
                        tabList: 'w-full',
                        cursor: 'w-full',
                        tab: 'w-full',
                      }}
                    >
                      <Tab key="full" title={t('spectrum.radioSdrCenterViewFull')} />
                      <Tab key="left" title={t('spectrum.radioSdrCenterViewLeft')} />
                      <Tab key="right" title={t('spectrum.radioSdrCenterViewRight')} />
                    </Tabs>
                  </div>
                )}
                </div>
                </AccordionItem>
                <AccordionItem key="display" title={<span className="text-xs font-medium text-default-600">{t('spectrum.displaySettings')}</span>}>
                <div className="space-y-4">
                {!isRadioSdrSelected && !isOpenWebRXSdrSelected && (
                  <Tabs
                    selectedKey={audioRangeSettings.mode}
                    onSelectionChange={(key) => {
                      const nextMode = key as 'auto' | 'manual';
                      updateAudioRangeSettings(current => {
                        return resolveAudioRangeSettingsForModeChange(current, nextMode, actualRangeRef.current);
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
                  label={t('spectrum.minLevel', { unit: spectrumLevelUnit })}
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
                  label={t('spectrum.minLevel', { unit: spectrumLevelUnit })}
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
                  label={t('spectrum.maxLevel', { unit: spectrumLevelUnit })}
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
                  label={t('spectrum.maxLevel', { unit: spectrumLevelUnit })}
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
                </AccordionItem>
                </Accordion>
              </div>
            </div>
            {isAudioSpectrumSelected && customSpectrumEditing && canConfigureSpectrum && (
              <div className="flex shrink-0 justify-end gap-2 bg-content1 px-4 py-3">
                <Button size="sm" variant="light" onPress={handleCustomSpectrumCancel} isDisabled={spectrumPresetPending}>
                  {t('spectrum.cancel')}
                </Button>
                <Button size="sm" color="primary" onPress={() => { void handleCustomSpectrumSettingsApply(customSpectrumDraft); }} isDisabled={spectrumPresetPending}>
                  {t('spectrum.apply')}
                </Button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
