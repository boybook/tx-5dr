import { EventEmitter } from 'eventemitter3';
import type {
  SpectrumFrame,
  SpectrumKind,
  SpectrumSessionControl,
  SpectrumSessionPresetMarker,
  SpectrumSessionState,
  SpectrumSessionSourceMode,
} from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { ConfigManager } from '../config/config-manager.js';
import type {
  IRadioConnection,
  SpectrumDisplayMode,
} from '../radio/connections/IRadioConnection.js';
import { HamlibConnection } from '../radio/connections/HamlibConnection.js';
import { IcomWlanConnection } from '../radio/connections/IcomWlanConnection.js';
import { createLogger } from '../utils/logger.js';
import type { SpectrumCoordinator } from './SpectrumCoordinator.js';

const logger = createLogger('SpectrumSessionCoordinator');

const DISPLAY_STATE_POLL_INTERVAL_MS = 2000;
const VOICE_STATE_POLL_INTERVAL_MS = 2000;
const DISPLAY_STATE_RETRY_MS = 30_000;
const ZOOM_CONFIRM_TIMEOUT_MS = 2000;
const STANDARD_FREQUENCY_TOLERANCE_HZ = 1500;
const ACTIVE_WINDOW_TOLERANCE_HZ = 10;
const DIGITAL_WINDOW_LOW_OFFSET_HZ = -1000;
const DIGITAL_WINDOW_HIGH_OFFSET_HZ = 4000;
const DIGITAL_WINDOW_PENDING_TIMEOUT_MS = 3000;
const OPENWEBRX_DETAIL_OFFSET_HZ = 1500;
const VOICE_FREQUENCY_GESTURE_STEP_HZ = 1000;

function formatPresetMarkerLabel(frequencyHz: number): string {
  return `${(frequencyHz / 1_000_000).toFixed(3)} MHz`;
}

interface SpectrumSessionCoordinatorEvents {
  stateChanged: () => void;
}

interface VoiceState {
  radioMode: string | null;
  bandwidthLabel: string | null;
  occupiedBandwidthHz: number | null;
  offsetModel: 'upper' | 'lower' | 'symmetric' | null;
}

interface ZoomState {
  levels: Array<{ id: string; spanHz: number }>;
  currentLevelId: string | null;
  currentSpanHz: number | null;
  canZoomIn: boolean;
  canZoomOut: boolean;
  visible: boolean;
  enabled: boolean;
  pending: boolean;
}

interface DigitalWindowState {
  supported: boolean;
  active: boolean;
  pending: boolean;
  canToggle: boolean;
  standardFrequencyHz: number | null;
  lowHz: number | null;
  highHz: number | null;
}

interface PendingDigitalTransition {
  mode: 'activate' | 'deactivate';
  lowHz: number | null;
  highHz: number | null;
  expiresAt: number;
}

const EMPTY_VOICE_STATE: VoiceState = {
  radioMode: null,
  bandwidthLabel: null,
  occupiedBandwidthHz: null,
  offsetModel: null,
};

function normalizeRadioFrequency(frequency: number | null | undefined): number | null {
  return typeof frequency === 'number' && Number.isFinite(frequency) && frequency > 0
    ? frequency
    : null;
}

export class SpectrumSessionCoordinator extends EventEmitter<SpectrumSessionCoordinatorEvents> {
  private readonly stateCache = new Map<string, { version: number; state: SpectrumSessionState }>();
  private dirtyVersion = 0;
  private lastRadioFrame: SpectrumFrame | null = null;
  private lastKnownRadioFrequency: number | null = null;
  private cachedVoiceState: VoiceState = EMPTY_VOICE_STATE;
  private displayPollTimer: NodeJS.Timeout | null = null;
  private voicePollTimer: NodeJS.Timeout | null = null;
  private displayStateFailedAt: number | null = null;
  private pendingTargetSpanHz: number | null = null;
  private pendingConnectionType: 'hamlib' | 'icom-wlan' | null = null;
  private pendingZoomTimer: NodeJS.Timeout | null = null;
  private pendingDigitalTransition: PendingDigitalTransition | null = null;
  private voiceFollowSyncPromise: Promise<void> | null = null;

  constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly spectrumCoordinator: SpectrumCoordinator,
  ) {
    super();

    this.engine.on('radioStatusChanged', () => {
      this.displayStateFailedAt = null;
      if (!this.engine.getRadioManager().isConnected()) {
        this.lastKnownRadioFrequency = null;
        this.cachedVoiceState = EMPTY_VOICE_STATE;
        this.clearPendingZoom();
        this.clearPendingDigitalTransition();
      }
      this.updatePollingState();
      void this.ensureVoiceRadioFollowMode();
      this.markDirty();
    });

    this.engine.on('profileChanged', () => {
      this.displayStateFailedAt = null;
      this.clearPendingZoom();
      this.clearPendingDigitalTransition();
      void this.ensureVoiceRadioFollowMode();
      this.markDirty();
    });

    this.engine.on('modeChanged', () => {
      this.updatePollingState();
      void this.ensureVoiceRadioFollowMode();
      this.markDirty();
    });

    this.engine.on('voiceRadioModeChanged', () => {
      this.markDirty();
    });

    this.engine.on('frequencyChanged', (data) => {
      this.lastKnownRadioFrequency = normalizeRadioFrequency(data.frequency);
      void this.handleFrequencyChanged(data);
    });

    this.spectrumCoordinator.on('frame', (frame) => {
      if (frame.kind === 'radio-sdr') {
        this.lastRadioFrame = frame;
        if (this.pendingTargetSpanHz !== null && this.isPendingZoomConfirmed(frame)) {
          this.clearPendingZoom();
        }
        this.resolvePendingDigitalTransition(frame.frequencyRange.min, frame.frequencyRange.max);
      }
      this.markDirty();
    });

    this.spectrumCoordinator.on('capabilitiesChanged', () => {
      this.markDirty();
    });

    this.updatePollingState();
  }

  async refresh(kind: SpectrumKind | null): Promise<SpectrumSessionState> {
    const key = kind ?? '__none__';
    const cached = this.stateCache.get(key);
    if (cached?.version === this.dirtyVersion) {
      return cached.state;
    }

    const state = await this.buildState(kind);
    this.stateCache.set(key, { version: this.dirtyVersion, state });
    return state;
  }

  async invokeControl(
    kind: SpectrumKind | null,
    id: string,
    action: 'in' | 'out' | 'toggle',
  ): Promise<void> {
    switch (id) {
      case 'zoom-step':
        if (kind === 'radio-sdr' && (action === 'in' || action === 'out')) {
          await this.stepRadioZoom(action);
        }
        break;
      case 'digital-window-toggle':
        if (kind === 'radio-sdr' && action === 'toggle') {
          await this.toggleDigitalWindow();
        }
        break;
      case 'openwebrx-detail-toggle':
        if (kind === 'openwebrx-sdr' && action === 'toggle') {
          await this.toggleOpenWebRXDetail();
        }
        break;
      case 'viewport-zoom':
        break;
      default:
        break;
    }

    this.markDirty();
  }

  private markDirty(): void {
    this.dirtyVersion += 1;
    this.emit('stateChanged');
  }

  private updatePollingState(): void {
    const connected = this.engine.getRadioManager().isConnected();
    if (connected && !this.displayPollTimer) {
      this.displayPollTimer = setInterval(() => {
        this.markDirty();
      }, DISPLAY_STATE_POLL_INTERVAL_MS);
    } else if (!connected && this.displayPollTimer) {
      clearInterval(this.displayPollTimer);
      this.displayPollTimer = null;
    }

    const shouldVoicePoll = connected && this.engine.getEngineMode() === 'voice';
    if (shouldVoicePoll && !this.voicePollTimer) {
      this.voicePollTimer = setInterval(() => {
        this.markDirty();
      }, VOICE_STATE_POLL_INTERVAL_MS);
    } else if (!shouldVoicePoll && this.voicePollTimer) {
      clearInterval(this.voicePollTimer);
      this.voicePollTimer = null;
    }
  }

  private async handleFrequencyChanged(data: { frequency?: number; mode?: string; source?: 'program' | 'radio' }): Promise<void> {
    if (data.source !== 'program') {
      this.markDirty();
      return;
    }

    const displayState = await this.resolveRadioDisplayState();
    const digitalWindowState = await this.buildDigitalWindowState(displayState);
    if (!digitalWindowState.active) {
      this.markDirty();
      return;
    }

    const connection = this.getDisplayConfigurableConnection();
    if (!connection?.configureSpectrumDisplay) {
      this.markDirty();
      return;
    }

    const modeName = data.mode === 'FT8' || data.mode === 'FT4'
      ? data.mode
      : this.engine.getStatus().currentMode.name;
    if (modeName !== 'FT8' && modeName !== 'FT4') {
      this.markDirty();
      return;
    }

    const frequency = normalizeRadioFrequency(data.frequency) ?? this.lastKnownRadioFrequency;
    if (frequency === null) {
      this.markDirty();
      return;
    }

    const standardFrequencyHz = await this.resolveStandardFrequency(modeName, frequency);
    if (standardFrequencyHz === null) {
      this.markDirty();
      return;
    }

    const lowHz = standardFrequencyHz + DIGITAL_WINDOW_LOW_OFFSET_HZ;
    const highHz = standardFrequencyHz + DIGITAL_WINDOW_HIGH_OFFSET_HZ;
    this.setPendingDigitalTransition({
      mode: 'activate',
      lowHz,
      highHz,
    });

    await connection.configureSpectrumDisplay({
      mode: 'fixed',
      edgeLowHz: lowHz,
      edgeHighHz: highHz,
    });

    this.markDirty();
  }

  private async buildState(kind: SpectrumKind | null): Promise<SpectrumSessionState> {
    const currentRadioFrequency = await this.resolveCurrentRadioFrequency();
    const voice = await this.resolveVoiceState(currentRadioFrequency);
    const standardFrequencyHz = await this.resolveCurrentStandardFrequency(currentRadioFrequency);

    switch (kind) {
      case 'audio':
        return {
          kind,
          sourceMode: 'baseband',
          frequencyRangeMode: 'baseband',
          displayRange: null,
          centerFrequency: null,
          currentRadioFrequency,
          standardFrequencyHz,
          edgeLowHz: null,
          edgeHighHz: null,
          spanHz: null,
          voice,
          interaction: {
            showTxMarkers: this.engine.getEngineMode() === 'digital',
            showRxMarkers: this.engine.getEngineMode() === 'digital',
            canDragTx: this.engine.getEngineMode() === 'digital',
            canRightClickSetFrequency: this.engine.getEngineMode() === 'digital',
            canDoubleClickSetFrequency: false,
            canDragFrequency: false,
            frequencyGestureTarget: this.engine.getEngineMode() === 'digital' ? 'operator-tx' : null,
            frequencyStepHz: this.engine.getEngineMode() === 'digital' ? 1 : null,
            presetMarkers: [],
            canDragVoiceOverlay: false,
            showVoiceOverlay: false,
            canLocalViewportZoom: false,
            canLocalViewportPan: false,
            supportsManualRange: true,
            supportsAutoRange: true,
            defaultRangeMode: 'auto',
          },
          controls: [],
        };
      case 'radio-sdr':
        return this.buildRadioSdrState(currentRadioFrequency, standardFrequencyHz, voice);
      case 'openwebrx-sdr':
        return this.buildOpenWebRXState(currentRadioFrequency, standardFrequencyHz, voice);
      default:
        return {
          kind: null,
          sourceMode: 'unknown',
          frequencyRangeMode: 'baseband',
          displayRange: null,
          centerFrequency: null,
          currentRadioFrequency,
          standardFrequencyHz,
          edgeLowHz: null,
          edgeHighHz: null,
          spanHz: null,
          voice,
          interaction: {
            showTxMarkers: false,
            showRxMarkers: false,
            canDragTx: false,
            canRightClickSetFrequency: false,
            canDoubleClickSetFrequency: false,
            canDragFrequency: false,
            frequencyGestureTarget: null,
            frequencyStepHz: null,
            presetMarkers: [],
            canDragVoiceOverlay: false,
            showVoiceOverlay: false,
            canLocalViewportZoom: false,
            canLocalViewportPan: false,
            supportsManualRange: false,
            supportsAutoRange: false,
            defaultRangeMode: null,
          },
          controls: [],
        };
    }
  }

  private async buildRadioSdrState(
    currentRadioFrequency: number | null,
    standardFrequencyHz: number | null,
    voice: VoiceState,
  ): Promise<SpectrumSessionState> {
    const display = await this.resolveRadioDisplayState(currentRadioFrequency);
    const zoom = await this.buildZoomState(display);
    const digitalWindow = await this.buildDigitalWindowState(display, standardFrequencyHz);
    const isVoiceMode = this.engine.getEngineMode() === 'voice';
    const sourceMode = this.mapRadioDisplayModeToSourceMode(display.mode);
    const isFixed = sourceMode === 'fixed' || sourceMode === 'scroll-fixed';
    const isDigital = this.engine.getEngineMode() === 'digital';
    const canVoiceSetFrequency = isVoiceMode
      && currentRadioFrequency !== null
      && display.displayRange !== null;
    const presetMarkers = isVoiceMode && display.displayRange
      ? this.resolveVoicePresetMarkers(display.displayRange.min, display.displayRange.max, canVoiceSetFrequency)
      : [];

    const controls: SpectrumSessionControl[] = [];
    if (zoom.visible) {
      controls.push({
        id: 'zoom-step',
        action: 'out',
        kind: 'server',
        visible: true,
        enabled: zoom.canZoomOut,
        active: false,
        pending: zoom.pending,
      });
      controls.push({
        id: 'zoom-step',
        action: 'in',
        kind: 'server',
        visible: true,
        enabled: zoom.canZoomIn,
        active: false,
        pending: zoom.pending,
      });
    }

    if (digitalWindow.supported) {
      controls.push({
        id: 'digital-window-toggle',
        action: 'toggle',
        kind: 'server',
        visible: true,
        enabled: digitalWindow.canToggle,
        active: digitalWindow.active,
        pending: digitalWindow.pending,
      });
    }

    return {
      kind: 'radio-sdr',
      sourceMode,
      frequencyRangeMode: isFixed ? 'absolute-fixed' : 'absolute-center',
      displayRange: display.displayRange,
      centerFrequency: display.centerFrequency,
      currentRadioFrequency,
      standardFrequencyHz: digitalWindow.standardFrequencyHz ?? standardFrequencyHz,
      edgeLowHz: display.edgeLowHz,
      edgeHighHz: display.edgeHighHz,
      spanHz: display.spanHz,
      voice,
      interaction: {
        showTxMarkers: isDigital,
        showRxMarkers: isDigital,
        canDragTx: isDigital,
        canRightClickSetFrequency: isDigital || canVoiceSetFrequency,
        canDoubleClickSetFrequency: canVoiceSetFrequency,
        // Voice-mode drag tuning is intentionally disabled for now.
        // In follow/center mode the SDR viewport recenters while dragging, which makes
        // whole-spectrum drag interaction feel jumpy and harder to control precisely.
        canDragFrequency: false,
        frequencyGestureTarget: isDigital ? 'operator-tx' : (canVoiceSetFrequency ? 'radio-frequency' : null),
        frequencyStepHz: isDigital ? 1 : (canVoiceSetFrequency ? VOICE_FREQUENCY_GESTURE_STEP_HZ : null),
        // Voice preset markers are negotiated here so SDR preset rendering stays on the
        // same capability/session-state channel as the rest of the spectrum interactions.
        presetMarkers,
        canDragVoiceOverlay: false,
        showVoiceOverlay: isVoiceMode,
        canLocalViewportZoom: false,
        canLocalViewportPan: false,
        supportsManualRange: true,
        supportsAutoRange: false,
        defaultRangeMode: 'manual',
      },
      controls,
    };
  }

  private async buildOpenWebRXState(
    currentRadioFrequency: number | null,
    standardFrequencyHz: number | null,
    voice: VoiceState,
  ): Promise<SpectrumSessionState> {
    const adapter = this.engine.getOpenWebRXAudioAdapter();
    const currentFrame = adapter?.getLatestSpectrumFrame() ?? null;
    const detailEnabled = Boolean(adapter?.isDigitalDetailSpectrumEnabled());
    const sourceMode: SpectrumSessionSourceMode = detailEnabled ? 'detail' : 'full';
    const isVoiceMode = this.engine.getEngineMode() === 'voice';
    const isDigitalMode = this.engine.getEngineMode() === 'digital'
      && (this.engine.getStatus().currentMode.name === 'FT8' || this.engine.getStatus().currentMode.name === 'FT4');

    const controls: SpectrumSessionControl[] = [];
    if (adapter?.isConnected() && isDigitalMode) {
      controls.push({
        id: 'openwebrx-detail-toggle',
        action: 'toggle',
        kind: 'server',
        visible: true,
        enabled: true,
        active: detailEnabled,
        pending: false,
      });
    }
    if (!detailEnabled) {
      controls.push({
        id: 'viewport-zoom',
        action: 'out',
        kind: 'local',
        visible: true,
        enabled: true,
        active: false,
        pending: false,
      });
      controls.push({
        id: 'viewport-zoom',
        action: 'in',
        kind: 'local',
        visible: true,
        enabled: true,
        active: false,
        pending: false,
      });
    }

    const displayRange = detailEnabled
      ? (
          typeof currentFrame?.lowCut === 'number'
          && typeof currentFrame?.highCut === 'number'
          && Number.isFinite(currentFrame.lowCut)
          && Number.isFinite(currentFrame.highCut)
          && currentFrame.highCut > currentFrame.lowCut
            ? {
                min: currentFrame.lowCut,
                max: currentFrame.highCut,
              }
            : (
                typeof currentFrame?.ifSampleRate === 'number'
                && Number.isFinite(currentFrame.ifSampleRate)
                && currentFrame.ifSampleRate > 0
                  ? {
                      min: 0,
                      max: currentFrame.ifSampleRate,
                    }
                  : null
              )
        )
      : (
          currentFrame?.absoluteRange
            ? {
                min: currentFrame.absoluteRange.min,
                max: currentFrame.absoluteRange.max,
              }
            : (
                typeof currentFrame?.centerFreq === 'number'
                && Number.isFinite(currentFrame.centerFreq)
                && typeof currentFrame?.sampleRate === 'number'
                && Number.isFinite(currentFrame.sampleRate)
                && currentFrame.sampleRate > 0
                  ? {
                      min: currentFrame.centerFreq - currentFrame.sampleRate / 2,
                      max: currentFrame.centerFreq + currentFrame.sampleRate / 2,
                    }
                  : null
              )
        );
    const presetMarkers = isVoiceMode && displayRange
      ? this.resolveVoicePresetMarkers(displayRange.min, displayRange.max, true)
      : [];

    return {
      kind: 'openwebrx-sdr',
      sourceMode,
      frequencyRangeMode: detailEnabled ? 'baseband' : 'absolute-windowed',
      displayRange,
      centerFrequency: detailEnabled
        ? (displayRange ? (displayRange.min + displayRange.max) / 2 : null)
        : (currentFrame?.centerFreq ?? null),
      currentRadioFrequency,
      standardFrequencyHz,
      edgeLowHz: null,
      edgeHighHz: null,
      spanHz: displayRange ? displayRange.max - displayRange.min : null,
      voice,
      interaction: {
        showTxMarkers: detailEnabled,
        showRxMarkers: detailEnabled,
        canDragTx: detailEnabled && isDigitalMode,
        canRightClickSetFrequency: detailEnabled && isDigitalMode,
        canDoubleClickSetFrequency: false,
        canDragFrequency: false,
        frequencyGestureTarget: detailEnabled && isDigitalMode ? 'operator-tx' : null,
        frequencyStepHz: detailEnabled && isDigitalMode ? 1 : null,
        presetMarkers,
        canDragVoiceOverlay: false,
        showVoiceOverlay: false,
        canLocalViewportZoom: !detailEnabled,
        canLocalViewportPan: !detailEnabled,
        supportsManualRange: true,
        supportsAutoRange: false,
        defaultRangeMode: 'manual',
      },
      controls,
    };
  }

  private async resolveCurrentRadioFrequency(): Promise<number | null> {
    if (!this.engine.getRadioManager().isConnected()) {
      return null;
    }

    if (this.lastKnownRadioFrequency !== null) {
      return this.lastKnownRadioFrequency;
    }

    try {
      this.lastKnownRadioFrequency = normalizeRadioFrequency(await this.engine.getRadioManager().getFrequency());
    } catch (error) {
      logger.debug('Failed to read current radio frequency for spectrum session', error);
    }

    return this.lastKnownRadioFrequency;
  }

  private async resolveRadioDisplayState(
    currentRadioFrequencyOverride?: number | null,
  ): Promise<{
    mode: SpectrumDisplayMode | 'unknown';
    displayRange: SpectrumSessionState['displayRange'];
    centerFrequency: number | null;
    edgeLowHz: number | null;
    edgeHighHz: number | null;
    spanHz: number | null;
    supportsFixedEdges: boolean;
    supportsSpanControl: boolean;
  }> {
    const currentRadioFrequency = normalizeRadioFrequency(currentRadioFrequencyOverride) ?? this.lastKnownRadioFrequency;
    const activeConnection = this.engine.getRadioManager().getActiveConnection();
    const now = Date.now();
    const canTryDisplayState = Boolean(activeConnection?.getSpectrumDisplayState)
      && (this.displayStateFailedAt === null || now - this.displayStateFailedAt >= DISPLAY_STATE_RETRY_MS);
    const configured = canTryDisplayState
      ? await activeConnection!.getSpectrumDisplayState!().catch((error) => {
          logger.debug('Failed to read spectrum display state', error);
          this.displayStateFailedAt = now;
          return null;
        })
      : null;

    if (configured) {
      this.displayStateFailedAt = null;
    }

    const mode = this.resolveDisplayMode(
      configured?.mode ?? null,
      configured?.edgeLowHz ?? null,
      configured?.edgeHighHz ?? null,
      configured?.spanHz ?? null,
    );

    const displayRange = this.resolveDisplayRange(mode, configured?.edgeLowHz ?? null, configured?.edgeHighHz ?? null);
    const edgeLowHz = (mode === 'fixed' || mode === 'scroll-fixed') && displayRange
      ? displayRange.min
      : (typeof configured?.edgeLowHz === 'number' ? configured.edgeLowHz : null);
    const edgeHighHz = (mode === 'fixed' || mode === 'scroll-fixed') && displayRange
      ? displayRange.max
      : (typeof configured?.edgeHighHz === 'number' ? configured.edgeHighHz : null);
    const centerFrequency = this.resolveCenterFrequency(displayRange, currentRadioFrequency);
    const spanHz = this.resolveSpanHz(displayRange, configured?.spanHz ?? null);

    return {
      mode,
      displayRange,
      centerFrequency,
      edgeLowHz,
      edgeHighHz,
      spanHz,
      supportsFixedEdges: Boolean(
        configured?.supportsFixedEdges
        || (activeConnection?.configureSpectrumDisplay && activeConnection?.getSpectrumDisplayState),
      ),
      supportsSpanControl: (configured?.supportedSpans?.length ?? 0) > 0,
    };
  }

  private resolveDisplayMode(
    mode: SpectrumDisplayMode | null,
    edgeLowHz: number | null,
    edgeHighHz: number | null,
    spanHz: number | null,
  ): SpectrumDisplayMode | 'unknown' {
    if (mode === 'center' || mode === 'fixed' || mode === 'scroll-center' || mode === 'scroll-fixed') {
      return mode;
    }

    if (
      typeof edgeLowHz === 'number'
      && Number.isFinite(edgeLowHz)
      && typeof edgeHighHz === 'number'
      && Number.isFinite(edgeHighHz)
      && edgeHighHz > edgeLowHz
    ) {
      return 'fixed';
    }

    if (
      (this.lastRadioFrame && this.lastRadioFrame.kind === 'radio-sdr')
      || (typeof spanHz === 'number' && Number.isFinite(spanHz) && spanHz > 0)
    ) {
      return 'center';
    }

    return 'unknown';
  }

  private resolveDisplayRange(
    mode: SpectrumDisplayMode | 'unknown',
    edgeLowHz: number | null,
    edgeHighHz: number | null,
  ): SpectrumSessionState['displayRange'] {
    if (this.lastRadioFrame) {
      return {
        min: this.lastRadioFrame.frequencyRange.min,
        max: this.lastRadioFrame.frequencyRange.max,
      };
    }

    if ((mode === 'fixed' || mode === 'scroll-fixed')
      && typeof edgeLowHz === 'number'
      && typeof edgeHighHz === 'number'
      && Number.isFinite(edgeLowHz)
      && Number.isFinite(edgeHighHz)
      && edgeHighHz > edgeLowHz) {
      return {
        min: edgeLowHz,
        max: edgeHighHz,
      };
    }

    return null;
  }

  private resolveCenterFrequency(
    displayRange: SpectrumSessionState['displayRange'],
    currentRadioFrequency: number | null,
  ): number | null {
    if (this.lastRadioFrame && typeof this.lastRadioFrame.meta.centerFrequency === 'number' && Number.isFinite(this.lastRadioFrame.meta.centerFrequency)) {
      return this.lastRadioFrame.meta.centerFrequency;
    }

    if (displayRange) {
      return displayRange.min + (displayRange.max - displayRange.min) / 2;
    }

    return currentRadioFrequency;
  }

  private resolveSpanHz(
    displayRange: SpectrumSessionState['displayRange'],
    configuredSpanHz: number | null,
  ): number | null {
    if (this.lastRadioFrame && typeof this.lastRadioFrame.meta.spanHz === 'number' && Number.isFinite(this.lastRadioFrame.meta.spanHz)) {
      return this.lastRadioFrame.meta.spanHz;
    }

    if (typeof configuredSpanHz === 'number' && Number.isFinite(configuredSpanHz) && configuredSpanHz > 0) {
      return configuredSpanHz;
    }

    if (displayRange) {
      return displayRange.max - displayRange.min;
    }

    return null;
  }

  private async buildZoomState(display: Awaited<ReturnType<SpectrumSessionCoordinator['resolveRadioDisplayState']>>): Promise<ZoomState> {
    const connection = this.getZoomCapableConnection();
    const isCenterMode = display.mode === 'center' || display.mode === 'scroll-center';
    if (!connection || !this.engine.getRadioManager().isConnected() || !isCenterMode) {
      return {
        levels: [],
        currentLevelId: null,
        currentSpanHz: null,
        canZoomIn: false,
        canZoomOut: false,
        visible: false,
        enabled: false,
        pending: false,
      };
    }

    const levels = await this.getZoomLevels(connection);
    if (levels.length === 0) {
      return {
        levels: [],
        currentLevelId: null,
        currentSpanHz: null,
        canZoomIn: false,
        canZoomOut: false,
        visible: false,
        enabled: false,
        pending: false,
      };
    }

    const currentSpanHz = await this.resolveCurrentSpan(connection, display.spanHz);
    const currentLevel = this.resolveCurrentLevel(levels, currentSpanHz);
    const currentIndex = currentLevel ? levels.findIndex(level => level.id === currentLevel.id) : -1;
    return {
      levels,
      currentLevelId: currentLevel?.id ?? null,
      currentSpanHz,
      canZoomIn: this.pendingTargetSpanHz === null && currentIndex >= 0 && currentIndex < levels.length - 1,
      canZoomOut: this.pendingTargetSpanHz === null && currentIndex > 0,
      visible: true,
      enabled: true,
      pending: this.pendingTargetSpanHz !== null,
    };
  }

  private async stepRadioZoom(direction: 'in' | 'out'): Promise<void> {
    const display = await this.resolveRadioDisplayState();
    const zoom = await this.buildZoomState(display);
    if (!zoom.visible || !zoom.currentLevelId) {
      return;
    }

    const currentIndex = zoom.levels.findIndex(level => level.id === zoom.currentLevelId);
    if (currentIndex < 0) {
      return;
    }

    const nextIndex = direction === 'in' ? currentIndex + 1 : currentIndex - 1;
    const nextLevel = zoom.levels[nextIndex];
    if (!nextLevel) {
      return;
    }

    const connection = this.getZoomCapableConnection();
    if (!connection?.setSpectrumSpan) {
      return;
    }

    this.pendingTargetSpanHz = nextLevel.spanHz;
    this.pendingConnectionType = connection instanceof HamlibConnection ? 'hamlib' : 'icom-wlan';
    this.resetPendingZoomTimer();
    await connection.setSpectrumSpan(nextLevel.spanHz);
  }

  private getZoomCapableConnection(): HamlibConnection | IcomWlanConnection | null {
    const radioManager = this.engine.getRadioManager();
    const activeConnection = radioManager.getActiveConnection();
    if (activeConnection instanceof HamlibConnection && typeof activeConnection.getSpectrumSpans === 'function') {
      return activeConnection;
    }

    const wlanManager = radioManager.getIcomWlanManager();
    if (wlanManager instanceof IcomWlanConnection && typeof wlanManager.getSpectrumSpans === 'function') {
      return wlanManager;
    }

    return null;
  }

  private async getZoomLevels(connection: HamlibConnection | IcomWlanConnection): Promise<Array<{ id: string; spanHz: number }>> {
    const spans = await connection.getSpectrumSpans?.();
    return Array.from(new Set((spans ?? []).filter((span): span is number => Number.isFinite(span) && span > 0)))
      .sort((left, right) => right - left)
      .map(spanHz => ({ id: String(spanHz), spanHz }));
  }

  private async resolveCurrentSpan(
    connection: HamlibConnection | IcomWlanConnection,
    displaySpanHz: number | null,
  ): Promise<number | null> {
    const queriedSpanHz = await connection.getCurrentSpectrumSpan?.();
    if (typeof queriedSpanHz === 'number' && Number.isFinite(queriedSpanHz) && queriedSpanHz > 0) {
      return queriedSpanHz;
    }

    if (this.lastRadioFrame) {
      const frameSpanHz = this.lastRadioFrame.meta.spanHz ?? Math.abs(this.lastRadioFrame.frequencyRange.max - this.lastRadioFrame.frequencyRange.min);
      if (Number.isFinite(frameSpanHz) && frameSpanHz > 0) {
        return connection instanceof IcomWlanConnection ? Math.round(frameSpanHz / 2) : Math.round(frameSpanHz);
      }
    }

    return typeof displaySpanHz === 'number' && Number.isFinite(displaySpanHz) && displaySpanHz > 0
      ? displaySpanHz
      : null;
  }

  private resolveCurrentLevel(
    levels: Array<{ id: string; spanHz: number }>,
    currentSpanHz: number | null,
  ): { id: string; spanHz: number } | null {
    if (!Number.isFinite(currentSpanHz) || currentSpanHz === null || currentSpanHz <= 0) {
      return null;
    }

    const exactMatch = levels.find(level => level.spanHz === currentSpanHz);
    if (exactMatch) {
      return exactMatch;
    }

    let nearest: { id: string; spanHz: number } | null = null;
    let nearestDelta = Number.POSITIVE_INFINITY;
    for (const level of levels) {
      const delta = Math.abs(level.spanHz - currentSpanHz);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearest = level;
      }
    }

    if (!nearest) {
      return null;
    }

    return nearestDelta / nearest.spanHz <= 0.2 ? nearest : null;
  }

  private isPendingZoomConfirmed(frame: SpectrumFrame): boolean {
    if (this.pendingTargetSpanHz === null || this.pendingConnectionType === null) {
      return false;
    }

    const frameSpanHz = frame.meta.spanHz ?? Math.abs(frame.frequencyRange.max - frame.frequencyRange.min);
    if (!Number.isFinite(frameSpanHz) || frameSpanHz <= 0) {
      return false;
    }

    if (this.pendingConnectionType === 'icom-wlan') {
      return Math.abs(frameSpanHz - (this.pendingTargetSpanHz * 2)) <= 1;
    }
    return Math.abs(frameSpanHz - this.pendingTargetSpanHz) <= 1;
  }

  private resetPendingZoomTimer(): void {
    if (this.pendingZoomTimer) {
      clearTimeout(this.pendingZoomTimer);
    }
    this.pendingZoomTimer = setTimeout(() => {
      this.pendingZoomTimer = null;
      this.clearPendingZoom();
      this.markDirty();
    }, ZOOM_CONFIRM_TIMEOUT_MS);
  }

  private clearPendingZoom(): void {
    this.pendingTargetSpanHz = null;
    this.pendingConnectionType = null;
    if (this.pendingZoomTimer) {
      clearTimeout(this.pendingZoomTimer);
      this.pendingZoomTimer = null;
    }
  }

  private async buildDigitalWindowState(
    display: Awaited<ReturnType<SpectrumSessionCoordinator['resolveRadioDisplayState']>>,
    standardFrequencyHint?: number | null,
  ): Promise<DigitalWindowState> {
    if (!this.engine.getRadioManager().isConnected() || this.engine.getEngineMode() !== 'digital') {
      this.clearPendingDigitalTransition();
      return this.createEmptyDigitalWindowState();
    }

    const currentModeName = this.engine.getStatus().currentMode.name;
    if (currentModeName !== 'FT8' && currentModeName !== 'FT4') {
      this.clearPendingDigitalTransition();
      return this.createEmptyDigitalWindowState();
    }

    const connection = this.getDisplayConfigurableConnection();
    const supported = Boolean(connection?.configureSpectrumDisplay && connection?.getSpectrumDisplayState);
    if (!supported) {
      this.clearPendingDigitalTransition();
      return this.createEmptyDigitalWindowState();
    }

    const standardFrequencyHz = standardFrequencyHint ?? await this.resolveStandardFrequency(currentModeName, this.lastKnownRadioFrequency);
    if (standardFrequencyHz === null) {
      this.clearPendingDigitalTransition();
      return this.createEmptyDigitalWindowState();
    }

    const lowHz = standardFrequencyHz + DIGITAL_WINDOW_LOW_OFFSET_HZ;
    const highHz = standardFrequencyHz + DIGITAL_WINDOW_HIGH_OFFSET_HZ;
    const fixedMode = display.mode === 'fixed' || display.mode === 'scroll-fixed';
    const active = fixedMode
      && this.isWithinTolerance(display.edgeLowHz, lowHz, ACTIVE_WINDOW_TOLERANCE_HZ)
      && this.isWithinTolerance(display.edgeHighHz, highHz, ACTIVE_WINDOW_TOLERANCE_HZ);
    const pending = this.resolvePendingDigitalState(display, lowHz, highHz);

    return {
      supported: true,
      active,
      pending,
      canToggle: !pending,
      standardFrequencyHz,
      lowHz,
      highHz,
    };
  }

  private createEmptyDigitalWindowState(): DigitalWindowState {
    return {
      supported: false,
      active: false,
      pending: false,
      canToggle: false,
      standardFrequencyHz: null,
      lowHz: null,
      highHz: null,
    };
  }

  private async toggleDigitalWindow(): Promise<void> {
    const display = await this.resolveRadioDisplayState();
    const state = await this.buildDigitalWindowState(display);
    if (!state.supported || !state.canToggle || state.standardFrequencyHz === null) {
      return;
    }

    const connection = this.getDisplayConfigurableConnection();
    if (!connection?.configureSpectrumDisplay) {
      return;
    }

    if (state.active) {
      this.setPendingDigitalTransition({ mode: 'deactivate', lowHz: null, highHz: null });
      await connection.configureSpectrumDisplay({ mode: 'center' });
    } else {
      this.setPendingDigitalTransition({
        mode: 'activate',
        lowHz: state.lowHz,
        highHz: state.highHz,
      });
      await connection.configureSpectrumDisplay({
        mode: 'fixed',
        edgeLowHz: state.lowHz ?? undefined,
        edgeHighHz: state.highHz ?? undefined,
      });
    }
  }

  private async resolveCurrentStandardFrequency(currentRadioFrequency: number | null): Promise<number | null> {
    if (this.engine.getEngineMode() !== 'digital') {
      return null;
    }

    const modeName = this.engine.getStatus().currentMode.name;
    if (modeName !== 'FT8' && modeName !== 'FT4') {
      return null;
    }

    return this.resolveStandardFrequency(modeName, currentRadioFrequency);
  }

  private async resolveStandardFrequency(
    modeName: 'FT8' | 'FT4',
    currentRadioFrequency: number | null,
  ): Promise<number | null> {
    const configManager = ConfigManager.getInstance();
    const frequencyManager = new FrequencyManager(configManager.getCustomFrequencyPresets());

    if (typeof currentRadioFrequency === 'number' && Number.isFinite(currentRadioFrequency)) {
      const match = frequencyManager.findMatchingPreset(currentRadioFrequency, STANDARD_FREQUENCY_TOLERANCE_HZ);
      if (match.preset && match.preset.mode === modeName) {
        return match.preset.frequency;
      }
    }

    const lastSelectedFrequency = configManager.getLastSelectedFrequency();
    if (lastSelectedFrequency && lastSelectedFrequency.mode === modeName) {
      return lastSelectedFrequency.frequency;
    }

    if (typeof currentRadioFrequency === 'number' && Number.isFinite(currentRadioFrequency)) {
      return currentRadioFrequency;
    }

    return null;
  }

  private resolveVoicePresetMarkers(
    rangeMin: number,
    rangeMax: number,
    clickable: boolean,
  ): SpectrumSessionPresetMarker[] {
    const configManager = ConfigManager.getInstance();
    const frequencyManager = new FrequencyManager(configManager.getCustomFrequencyPresets());

    return frequencyManager
      .getPresets()
      .filter((preset) => preset.mode === 'VOICE')
      .filter((preset) => Number.isFinite(preset.frequency) && preset.frequency >= rangeMin && preset.frequency <= rangeMax)
      .map((preset) => ({
        id: `voice-preset-${preset.frequency}`,
        frequency: preset.frequency,
        label: formatPresetMarkerLabel(preset.frequency),
        description: preset.description?.trim() || null,
        clickable,
      }));
  }

  private async ensureVoiceRadioFollowMode(): Promise<void> {
    if (this.engine.getEngineMode() !== 'voice') {
      return;
    }

    if (this.voiceFollowSyncPromise) {
      return this.voiceFollowSyncPromise;
    }

    this.voiceFollowSyncPromise = this.doEnsureVoiceRadioFollowMode()
      .finally(() => {
        this.voiceFollowSyncPromise = null;
      });

    return this.voiceFollowSyncPromise;
  }

  private async doEnsureVoiceRadioFollowMode(): Promise<void> {
    if (!this.engine.getRadioManager().isConnected()) {
      return;
    }

    const connection = this.getDisplayConfigurableConnection();
    if (!connection?.configureSpectrumDisplay || !connection.getSpectrumDisplayState) {
      return;
    }

    try {
      const displayState = await connection.getSpectrumDisplayState();
      if (!displayState) {
        return;
      }
      const currentMode = displayState.mode;
      if (currentMode === 'center' || currentMode === 'scroll-center') {
        return;
      }

      this.clearPendingDigitalTransition();
      await connection.configureSpectrumDisplay({ mode: 'center' });
      logger.info('Restored radio spectrum to follow mode for voice');
    } catch (error) {
      logger.warn('Failed to restore radio spectrum follow mode for voice', error);
    }
  }

  private getDisplayConfigurableConnection(): IRadioConnection | null {
    const connection = this.engine.getRadioManager().getActiveConnection();
    if (!connection || typeof connection.configureSpectrumDisplay !== 'function') {
      return null;
    }
    return connection;
  }

  private isWithinTolerance(actual: number | null, expected: number, tolerance: number): boolean {
    return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  }

  private setPendingDigitalTransition(target: Pick<PendingDigitalTransition, 'mode' | 'lowHz' | 'highHz'>): void {
    this.pendingDigitalTransition = {
      ...target,
      expiresAt: Date.now() + DIGITAL_WINDOW_PENDING_TIMEOUT_MS,
    };
  }

  private clearPendingDigitalTransition(): void {
    this.pendingDigitalTransition = null;
  }

  private resolvePendingDigitalTransition(edgeLowHz: number, edgeHighHz: number): void {
    if (!this.pendingDigitalTransition) {
      return;
    }
    const pending = this.pendingDigitalTransition;
    if (pending.expiresAt <= Date.now()) {
      this.clearPendingDigitalTransition();
      return;
    }
    const fixedMatched = pending.mode === 'activate'
      && this.isWithinTolerance(edgeLowHz, pending.lowHz ?? NaN, ACTIVE_WINDOW_TOLERANCE_HZ)
      && this.isWithinTolerance(edgeHighHz, pending.highHz ?? NaN, ACTIVE_WINDOW_TOLERANCE_HZ);
    if (fixedMatched) {
      this.clearPendingDigitalTransition();
    }
  }

  private resolvePendingDigitalState(
    display: Awaited<ReturnType<SpectrumSessionCoordinator['resolveRadioDisplayState']>>,
    targetLowHz: number,
    targetHighHz: number,
  ): boolean {
    if (!this.pendingDigitalTransition) {
      return false;
    }
    if (this.pendingDigitalTransition.expiresAt <= Date.now()) {
      this.clearPendingDigitalTransition();
      return false;
    }

    const fixedMode = display.mode === 'fixed' || display.mode === 'scroll-fixed';
    const fixedTargetMatched = fixedMode
      && this.isWithinTolerance(display.edgeLowHz, targetLowHz, ACTIVE_WINDOW_TOLERANCE_HZ)
      && this.isWithinTolerance(display.edgeHighHz, targetHighHz, ACTIVE_WINDOW_TOLERANCE_HZ);
    const centerMode = display.mode === 'center' || display.mode === 'scroll-center';

    if (this.pendingDigitalTransition.mode === 'activate' && fixedTargetMatched) {
      this.clearPendingDigitalTransition();
      return false;
    }
    if (this.pendingDigitalTransition.mode === 'deactivate' && centerMode) {
      this.clearPendingDigitalTransition();
      return false;
    }
    return true;
  }

  private async resolveVoiceState(currentRadioFrequency: number | null): Promise<VoiceState> {
    if (!this.engine.getRadioManager().isConnected()) {
      this.cachedVoiceState = EMPTY_VOICE_STATE;
      return this.cachedVoiceState;
    }

    let radioMode: string | null = this.cachedVoiceState.radioMode;
    let bandwidthLabel: string | number | null = this.cachedVoiceState.bandwidthLabel;

    try {
      const modeInfo = await this.engine.getRadioManager().getMode();
      radioMode = modeInfo.mode || null;
      bandwidthLabel = modeInfo.bandwidth || null;
    } catch (error) {
      logger.debug('Failed to read voice radio mode for spectrum session', error);
    }

    const normalized = this.normalizeVoiceMode(radioMode, bandwidthLabel);
    this.cachedVoiceState = {
      radioMode,
      bandwidthLabel: this.formatBandwidthLabel(bandwidthLabel),
      occupiedBandwidthHz: normalized.occupiedBandwidthHz,
      offsetModel: normalized.offsetModel,
    };

    if (currentRadioFrequency === null) {
      return this.cachedVoiceState;
    }

    return this.cachedVoiceState;
  }

  private normalizeVoiceMode(
    radioMode: string | null,
    bandwidthLabel: string | number | null,
  ): Pick<VoiceState, 'occupiedBandwidthHz' | 'offsetModel'> {
    if (!radioMode) {
      return { occupiedBandwidthHz: null, offsetModel: null };
    }

    const normalizedMode = radioMode.toUpperCase();
    const explicitBandwidthHz = typeof bandwidthLabel === 'number' && Number.isFinite(bandwidthLabel)
      ? Math.round(bandwidthLabel)
      : null;
    const profile = this.normalizeBandwidthProfile(bandwidthLabel);

    switch (normalizedMode) {
      case 'USB':
        return {
          occupiedBandwidthHz: explicitBandwidthHz ?? (profile === 'narrow' ? 2400 : profile === 'wide' ? 3000 : 2800),
          offsetModel: 'upper',
        };
      case 'LSB':
        return {
          occupiedBandwidthHz: explicitBandwidthHz ?? (profile === 'narrow' ? 2400 : profile === 'wide' ? 3000 : 2800),
          offsetModel: 'lower',
        };
      case 'AM':
        return {
          occupiedBandwidthHz: explicitBandwidthHz ?? (profile === 'narrow' ? 5000 : profile === 'wide' ? 9000 : 6000),
          offsetModel: 'symmetric',
        };
      case 'FM':
        return {
          occupiedBandwidthHz: explicitBandwidthHz ?? (profile === 'narrow' ? 6000 : profile === 'wide' ? 12000 : 10000),
          offsetModel: 'symmetric',
        };
      default:
        return {
          occupiedBandwidthHz: null,
          offsetModel: null,
        };
    }
  }

  private normalizeBandwidthProfile(bandwidthLabel: string | number | null): 'narrow' | 'normal' | 'wide' {
    if (!bandwidthLabel || typeof bandwidthLabel !== 'string') {
      return 'normal';
    }

    const normalized = bandwidthLabel.toLowerCase();
    if (/narrow|nar|fil1/.test(normalized)) {
      return 'narrow';
    }
    if (/wide|wid|fil3/.test(normalized)) {
      return 'wide';
    }
    return 'normal';
  }

  private formatBandwidthLabel(bandwidthLabel: string | number | null): string | null {
    if (bandwidthLabel === null || bandwidthLabel === undefined) {
      return null;
    }
    if (typeof bandwidthLabel === 'string') {
      return bandwidthLabel;
    }
    if (typeof bandwidthLabel === 'number' && Number.isFinite(bandwidthLabel)) {
      return `${Math.round(bandwidthLabel)} Hz`;
    }
    return String(bandwidthLabel);
  }

  private async toggleOpenWebRXDetail(): Promise<void> {
    const adapter = this.engine.getOpenWebRXAudioAdapter();
    if (!adapter?.isConnected()) {
      return;
    }

    if (adapter.isDigitalDetailSpectrumEnabled()) {
      adapter.disableDigitalDetailSpectrum();
      return;
    }

    const currentMode = this.engine.getStatus().currentMode.name;
    const detailMode = currentMode === 'FT4' ? 'ft4' : 'ft8';
    adapter.enableDigitalDetailSpectrum(detailMode, OPENWEBRX_DETAIL_OFFSET_HZ);
  }

  private mapRadioDisplayModeToSourceMode(mode: SpectrumDisplayMode | 'unknown'): SpectrumSessionSourceMode {
    switch (mode) {
      case 'center':
      case 'fixed':
      case 'scroll-center':
      case 'scroll-fixed':
        return mode;
      default:
        return 'unknown';
    }
  }
}
