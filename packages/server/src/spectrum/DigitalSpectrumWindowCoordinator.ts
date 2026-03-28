import { EventEmitter } from 'eventemitter3';
import type { DigitalSpectrumWindowState } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { IRadioConnection } from '../radio/connections/IRadioConnection.js';
import type { SpectrumDisplayStateCoordinator } from './SpectrumDisplayStateCoordinator.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';

const STANDARD_FREQUENCY_TOLERANCE_HZ = 1500;
const ACTIVE_WINDOW_TOLERANCE_HZ = 10;
const DIGITAL_WINDOW_LOW_OFFSET_HZ = -1000;
const DIGITAL_WINDOW_HIGH_OFFSET_HZ = 4000;
const PENDING_TIMEOUT_MS = 3000;
const logger = createLogger('DigitalSpectrumWindowCoordinator');

interface DigitalSpectrumWindowCoordinatorEvents {
  stateChanged: (state: DigitalSpectrumWindowState) => void;
}

const EMPTY_STATE: DigitalSpectrumWindowState = {
  supported: false,
  active: false,
  pending: false,
  canToggle: false,
  standardFrequencyHz: null,
  lowHz: null,
  highHz: null,
};

interface PendingTransition {
  mode: 'activate' | 'deactivate';
  lowHz: number | null;
  highHz: number | null;
  expiresAt: number;
}

export class DigitalSpectrumWindowCoordinator extends EventEmitter<DigitalSpectrumWindowCoordinatorEvents> {
  private currentState: DigitalSpectrumWindowState = EMPTY_STATE;
  private pendingTransition: PendingTransition | null = null;

  constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly spectrumDisplayStateCoordinator: SpectrumDisplayStateCoordinator,
  ) {
    super();

    this.engine.on('radioStatusChanged', () => {
      void this.refresh();
    });
    this.engine.on('profileChanged', () => {
      void this.refresh();
    });
    this.engine.on('modeChanged', () => {
      void this.refresh();
    });
    this.engine.on('frequencyChanged', (data) => {
      void this.handleFrequencyChanged(data);
    });
    this.spectrumDisplayStateCoordinator.on('stateChanged', () => {
      void this.refresh();
    });
  }

  getCurrentState(): DigitalSpectrumWindowState {
    return this.currentState;
  }

  async refresh(): Promise<DigitalSpectrumWindowState> {
    const nextState = await this.buildState();
    if (!this.areStatesEqual(this.currentState, nextState)) {
      this.currentState = nextState;
      logger.info('Digital spectrum window state updated', nextState);
      this.emit('stateChanged', nextState);
    } else {
      this.currentState = nextState;
    }
    return this.currentState;
  }

  async toggle(): Promise<void> {
    const state = await this.refresh();
    if (!state.supported || !state.canToggle || state.standardFrequencyHz === null) {
      return;
    }

    const connection = this.getDisplayConfigurableConnection();
    if (!connection?.configureSpectrumDisplay) {
      throw new Error('Spectrum display control is not available');
    }

    if (state.active) {
      this.setPendingTransition({
        mode: 'deactivate',
        lowHz: null,
        highHz: null,
      });
      await connection.configureSpectrumDisplay({
        mode: 'center',
      });
    } else {
      this.setPendingTransition({
        mode: 'activate',
        lowHz: state.lowHz ?? null,
        highHz: state.highHz ?? null,
      });
      await connection.configureSpectrumDisplay({
        mode: 'fixed',
        edgeLowHz: state.lowHz ?? undefined,
        edgeHighHz: state.highHz ?? undefined,
      });
    }

    await this.spectrumDisplayStateCoordinator.refresh();
    await this.refresh();
  }

  private async handleFrequencyChanged(data?: { frequency?: number; mode?: string; source?: 'program' | 'radio' }): Promise<void> {
    if (data?.source !== 'program') {
      await this.refresh();
      return;
    }

    const currentState = await this.refresh();
    if (!currentState.active) {
      return;
    }

    const modeName = data.mode === 'FT8' || data.mode === 'FT4'
      ? data.mode
      : this.engine.getStatus().currentMode.name;
    if (modeName !== 'FT8' && modeName !== 'FT4') {
      return;
    }

    const programmaticFrequency = typeof data.frequency === 'number' && Number.isFinite(data.frequency)
      ? data.frequency
      : this.spectrumDisplayStateCoordinator.getCurrentState().currentRadioFrequency;
    if (programmaticFrequency === null) {
      return;
    }

    const connection = this.getDisplayConfigurableConnection();
    if (!connection?.configureSpectrumDisplay) {
      return;
    }

    const standardFrequencyHz = await this.resolveStandardFrequency(modeName, programmaticFrequency);
    if (standardFrequencyHz === null) {
      return;
    }

    this.setPendingTransition({
      mode: 'activate',
      lowHz: standardFrequencyHz + DIGITAL_WINDOW_LOW_OFFSET_HZ,
      highHz: standardFrequencyHz + DIGITAL_WINDOW_HIGH_OFFSET_HZ,
    });

    await connection.configureSpectrumDisplay({
      mode: 'fixed',
      edgeLowHz: standardFrequencyHz + DIGITAL_WINDOW_LOW_OFFSET_HZ,
      edgeHighHz: standardFrequencyHz + DIGITAL_WINDOW_HIGH_OFFSET_HZ,
    });

    await this.spectrumDisplayStateCoordinator.refresh({ currentRadioFrequency: programmaticFrequency });
    await this.refresh();
  }

  private async buildState(): Promise<DigitalSpectrumWindowState> {
    const radioManager = this.engine.getRadioManager();
    if (!radioManager.isConnected()) {
      this.clearPendingTransition();
      return EMPTY_STATE;
    }

    if (this.engine.getEngineMode() !== 'digital') {
      this.clearPendingTransition();
      return EMPTY_STATE;
    }

    const currentModeName = this.engine.getStatus().currentMode.name;
    if (currentModeName !== 'FT8' && currentModeName !== 'FT4') {
      this.clearPendingTransition();
      return EMPTY_STATE;
    }

    const displayState = this.spectrumDisplayStateCoordinator.getCurrentState();
    const connection = this.getDisplayConfigurableConnection();
    const supported = Boolean(
      connection?.configureSpectrumDisplay
      && connection?.getSpectrumDisplayState,
    );

    if (!supported) {
      this.clearPendingTransition();
      return EMPTY_STATE;
    }

    const standardFrequencyHz = await this.resolveStandardFrequency(currentModeName, displayState.currentRadioFrequency);
    if (standardFrequencyHz === null) {
      this.clearPendingTransition();
      return EMPTY_STATE;
    }

    const lowHz = standardFrequencyHz + DIGITAL_WINDOW_LOW_OFFSET_HZ;
    const highHz = standardFrequencyHz + DIGITAL_WINDOW_HIGH_OFFSET_HZ;
    const fixedMode = displayState.mode === 'fixed' || displayState.mode === 'scroll-fixed';
    const active = fixedMode
      && this.isWithinTolerance(displayState.edgeLowHz, lowHz, ACTIVE_WINDOW_TOLERANCE_HZ)
      && this.isWithinTolerance(displayState.edgeHighHz, highHz, ACTIVE_WINDOW_TOLERANCE_HZ);
    const pending = this.resolvePendingState(displayState, lowHz, highHz);

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

  private setPendingTransition(target: Pick<PendingTransition, 'mode' | 'lowHz' | 'highHz'>): void {
    this.pendingTransition = {
      ...target,
      expiresAt: Date.now() + PENDING_TIMEOUT_MS,
    };
  }

  private clearPendingTransition(): void {
    this.pendingTransition = null;
  }

  private resolvePendingState(
    displayState: ReturnType<SpectrumDisplayStateCoordinator['getCurrentState']>,
    targetLowHz: number,
    targetHighHz: number,
  ): boolean {
    if (!this.pendingTransition) {
      return false;
    }

    if (this.pendingTransition.expiresAt <= Date.now()) {
      this.clearPendingTransition();
      return false;
    }

    const fixedMode = displayState.mode === 'fixed' || displayState.mode === 'scroll-fixed';
    const fixedTargetMatched = fixedMode
      && this.isWithinTolerance(displayState.edgeLowHz, targetLowHz, ACTIVE_WINDOW_TOLERANCE_HZ)
      && this.isWithinTolerance(displayState.edgeHighHz, targetHighHz, ACTIVE_WINDOW_TOLERANCE_HZ);
    const centerMode = displayState.mode === 'center' || displayState.mode === 'scroll-center';

    if (this.pendingTransition.mode === 'activate' && fixedTargetMatched) {
      this.clearPendingTransition();
      return false;
    }

    if (this.pendingTransition.mode === 'deactivate' && centerMode) {
      this.clearPendingTransition();
      return false;
    }

    return true;
  }

  private areStatesEqual(left: DigitalSpectrumWindowState, right: DigitalSpectrumWindowState): boolean {
    return left.supported === right.supported
      && left.active === right.active
      && left.pending === right.pending
      && left.canToggle === right.canToggle
      && left.standardFrequencyHz === right.standardFrequencyHz
      && left.lowHz === right.lowHz
      && left.highHz === right.highHz;
  }
}
