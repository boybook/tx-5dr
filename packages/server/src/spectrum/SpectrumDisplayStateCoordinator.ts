import { EventEmitter } from 'eventemitter3';
import type { SpectrumDisplayMode, SpectrumDisplayState, SpectrumFrame } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { SpectrumCoordinator } from './SpectrumCoordinator.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SpectrumDisplayStateCoordinator');
const DISPLAY_STATE_POLL_INTERVAL_MS = 2000;

interface SpectrumDisplayStateCoordinatorEvents {
  stateChanged: (state: SpectrumDisplayState) => void;
}

const EMPTY_STATE: SpectrumDisplayState = {
  mode: 'unknown',
  displayRange: null,
  centerFrequency: null,
  currentRadioFrequency: null,
  edgeLowHz: null,
  edgeHighHz: null,
  spanHz: null,
  supportsFixedEdges: false,
  supportsSpanControl: false,
};

function normalizeRadioFrequency(frequency: number | null | undefined): number | null {
  return typeof frequency === 'number' && Number.isFinite(frequency) && frequency > 0
    ? frequency
    : null;
}

export class SpectrumDisplayStateCoordinator extends EventEmitter<SpectrumDisplayStateCoordinatorEvents> {
  private currentState: SpectrumDisplayState = EMPTY_STATE;
  private lastRadioFrame: SpectrumFrame | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private displayStateFailedAt: number | null = null;
  private static readonly DISPLAY_STATE_RETRY_MS = 30_000;

  constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly spectrumCoordinator: SpectrumCoordinator,
  ) {
    super();

    this.engine.on('frequencyChanged', (data) => {
      void this.refresh({
        currentRadioFrequency: typeof data.frequency === 'number' ? data.frequency : null,
      });
    });
    this.engine.on('radioStatusChanged', () => {
      this.displayStateFailedAt = null;
      this.updatePollingState();
      void this.refresh();
    });
    this.engine.on('profileChanged', () => {
      void this.refresh();
    });
    this.engine.on('modeChanged', () => {
      void this.refresh();
    });
    this.spectrumCoordinator.on('frame', (frame) => {
      if (frame.kind !== 'radio-sdr') {
        return;
      }
      this.lastRadioFrame = frame;
      void this.refresh();
    });

    this.updatePollingState();
  }

  getCurrentState(): SpectrumDisplayState {
    return this.currentState;
  }

  async refresh(overrides?: { currentRadioFrequency?: number | null }): Promise<SpectrumDisplayState> {
    const nextState = await this.buildState(overrides);
    if (!this.areStatesEqual(this.currentState, nextState)) {
      this.currentState = nextState;
      this.emit('stateChanged', nextState);
    } else {
      this.currentState = nextState;
    }
    return this.currentState;
  }

  private updatePollingState(): void {
    const shouldPoll = this.engine.getRadioManager().isConnected();
    if (!shouldPoll) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      return;
    }

    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, DISPLAY_STATE_POLL_INTERVAL_MS);
  }

  private async buildState(overrides?: { currentRadioFrequency?: number | null }): Promise<SpectrumDisplayState> {
    const radioManager = this.engine.getRadioManager();
    if (!radioManager.isConnected()) {
      return EMPTY_STATE;
    }

    let currentRadioFrequency = overrides?.currentRadioFrequency;
    if (normalizeRadioFrequency(currentRadioFrequency) === null) {
      try {
        currentRadioFrequency = await radioManager.getFrequency();
      } catch (error) {
        logger.debug('Failed to read current radio frequency for spectrum display state', error);
        currentRadioFrequency = this.currentState.currentRadioFrequency;
      }
    }
    currentRadioFrequency = normalizeRadioFrequency(currentRadioFrequency);

    const activeConnection = radioManager.getActiveConnection();
    const now = Date.now();
    const canTryDisplayState = Boolean(activeConnection?.getSpectrumDisplayState)
      && (this.displayStateFailedAt === null
        || now - this.displayStateFailedAt >= SpectrumDisplayStateCoordinator.DISPLAY_STATE_RETRY_MS);
    const displayState = canTryDisplayState
      ? await activeConnection!.getSpectrumDisplayState!().catch((error) => {
          logger.debug('Failed to read spectrum display state from active connection', error);
          this.displayStateFailedAt = now;
          return null;
        })
      : null;
    if (displayState !== null) {
      this.displayStateFailedAt = null;
    }

    const mode = this.resolveMode(
      displayState?.mode,
      displayState?.edgeLowHz ?? null,
      displayState?.edgeHighHz ?? null,
      displayState?.spanHz ?? null,
    );
    const displayRange = this.resolveDisplayRange(mode, displayState?.edgeLowHz ?? null, displayState?.edgeHighHz ?? null);
    const resolvedEdgeLowHz = this.resolveEdgeLowHz(mode, displayRange, displayState?.edgeLowHz ?? null);
    const resolvedEdgeHighHz = this.resolveEdgeHighHz(mode, displayRange, displayState?.edgeHighHz ?? null);
    const centerFrequency = this.resolveCenterFrequency(displayRange, currentRadioFrequency ?? null);
    const spanHz = this.resolveSpanHz(displayRange, displayState?.spanHz ?? null);
    const supportsFixedEdges = Boolean(
      displayState?.supportsFixedEdges
      || (activeConnection?.configureSpectrumDisplay && activeConnection?.getSpectrumDisplayState),
    );

    return {
      mode,
      displayRange,
      centerFrequency,
      currentRadioFrequency,
      edgeLowHz: resolvedEdgeLowHz,
      edgeHighHz: resolvedEdgeHighHz,
      spanHz,
      supportsFixedEdges,
      supportsSpanControl: (displayState?.supportedSpans?.length ?? 0) > 0,
    };
  }

  private resolveMode(
    mode: string | null | undefined,
    edgeLowHz: number | null,
    edgeHighHz: number | null,
    spanHz: number | null,
  ): SpectrumDisplayMode {
    switch (mode) {
      case 'center':
      case 'fixed':
      case 'scroll-center':
      case 'scroll-fixed':
        return mode;
      default:
        break;
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
    mode: SpectrumDisplayMode,
    edgeLowHz: number | null,
    edgeHighHz: number | null,
  ): SpectrumDisplayState['displayRange'] {
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

  private resolveEdgeLowHz(
    mode: SpectrumDisplayMode,
    displayRange: SpectrumDisplayState['displayRange'],
    configuredEdgeLowHz: number | null,
  ): number | null {
    if ((mode === 'fixed' || mode === 'scroll-fixed') && displayRange) {
      return displayRange.min;
    }

    return typeof configuredEdgeLowHz === 'number' && Number.isFinite(configuredEdgeLowHz)
      ? configuredEdgeLowHz
      : null;
  }

  private resolveEdgeHighHz(
    mode: SpectrumDisplayMode,
    displayRange: SpectrumDisplayState['displayRange'],
    configuredEdgeHighHz: number | null,
  ): number | null {
    if ((mode === 'fixed' || mode === 'scroll-fixed') && displayRange) {
      return displayRange.max;
    }

    return typeof configuredEdgeHighHz === 'number' && Number.isFinite(configuredEdgeHighHz)
      ? configuredEdgeHighHz
      : null;
  }

  private resolveCenterFrequency(
    displayRange: SpectrumDisplayState['displayRange'],
    currentRadioFrequency: number | null,
  ): number | null {
    if (this.lastRadioFrame && typeof this.lastRadioFrame.meta.centerFrequency === 'number' && Number.isFinite(this.lastRadioFrame.meta.centerFrequency)) {
      return this.lastRadioFrame.meta.centerFrequency;
    }

    if (displayRange) {
      return displayRange.min + (displayRange.max - displayRange.min) / 2;
    }

    return typeof currentRadioFrequency === 'number' ? currentRadioFrequency : null;
  }

  private resolveSpanHz(
    displayRange: SpectrumDisplayState['displayRange'],
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

  private areStatesEqual(left: SpectrumDisplayState, right: SpectrumDisplayState): boolean {
    return left.mode === right.mode
      && left.displayRange?.min === right.displayRange?.min
      && left.displayRange?.max === right.displayRange?.max
      && left.centerFrequency === right.centerFrequency
      && left.currentRadioFrequency === right.currentRadioFrequency
      && left.edgeLowHz === right.edgeLowHz
      && left.edgeHighHz === right.edgeHighHz
      && left.spanHz === right.spanHz
      && left.supportsFixedEdges === right.supportsFixedEdges
      && left.supportsSpanControl === right.supportsSpanControl;
  }
}
