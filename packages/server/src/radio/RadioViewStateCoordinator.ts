import { EventEmitter } from 'eventemitter3';
import type { RadioViewState, SpectrumFrame } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { SpectrumCoordinator } from '../spectrum/SpectrumCoordinator.js';
import { HamlibConnection } from './connections/HamlibConnection.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioViewStateCoordinator');

const MODE_POLL_INTERVAL_MS = 2000;

type TrackingMode = RadioViewState['sdrTrackingMode'];
type OffsetModel = NonNullable<RadioViewState['offsetModel']>;

interface ModeNormalization {
  occupiedBandwidthHz: number | null;
  offsetModel: OffsetModel | null;
}

interface RadioViewStateCoordinatorEvents {
  stateChanged: (state: RadioViewState) => void;
}

export class RadioViewStateCoordinator extends EventEmitter<RadioViewStateCoordinatorEvents> {
  private currentState: RadioViewState = {
    frequency: null,
    radioMode: null,
    bandwidthLabel: null,
    occupiedBandwidthHz: null,
    offsetModel: null,
    sdrTrackingMode: 'unknown',
  };

  private pollTimer: NodeJS.Timeout | null = null;
  private lastRadioFrame: SpectrumFrame | null = null;

  constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly spectrumCoordinator: SpectrumCoordinator,
  ) {
    super();

    this.engine.on('frequencyChanged', (data) => {
      void this.refresh({
        frequency: typeof data.frequency === 'number' ? data.frequency : null,
      });
    });
    this.engine.on('voiceRadioModeChanged', () => {
      void this.refresh();
    });
    this.engine.on('radioStatusChanged', () => {
      this.updatePollingState();
      void this.refresh();
    });
    this.engine.on('profileChanged', () => {
      void this.refresh();
    });
    this.engine.on('modeChanged', () => {
      this.updatePollingState();
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

  getCurrentState(): RadioViewState {
    return this.currentState;
  }

  async refresh(overrides?: { frequency?: number | null }): Promise<RadioViewState> {
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
    const shouldPoll = this.engine.getRadioManager().isConnected() && this.engine.getEngineMode() === 'voice';
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
    }, MODE_POLL_INTERVAL_MS);
  }

  private async buildState(overrides?: { frequency?: number | null }): Promise<RadioViewState> {
    const radioManager = this.engine.getRadioManager();
    if (!radioManager.isConnected()) {
      return {
        frequency: null,
        radioMode: null,
        bandwidthLabel: null,
        occupiedBandwidthHz: null,
        offsetModel: null,
        sdrTrackingMode: 'unknown',
      };
    }

    let frequency = overrides?.frequency;
    if (typeof frequency !== 'number') {
      try {
        frequency = await radioManager.getFrequency();
      } catch (error) {
        logger.debug('Failed to read current radio frequency for view state', error);
        frequency = this.currentState.frequency;
      }
    }

    let radioMode: string | null = this.currentState.radioMode;
    let bandwidthLabel: string | number | null = this.currentState.bandwidthLabel;

    try {
      const modeInfo = await radioManager.getMode();
      radioMode = modeInfo.mode || null;
      bandwidthLabel = modeInfo.bandwidth || null;
    } catch (error) {
      logger.debug('Failed to read current radio mode for view state', error);
    }

    const normalized = this.normalizeMode(radioMode, bandwidthLabel);
    const sdrTrackingMode = await this.resolveTrackingMode(frequency ?? null);

    return {
      frequency: typeof frequency === 'number' ? frequency : null,
      radioMode,
      bandwidthLabel: this.formatBandwidthLabel(bandwidthLabel),
      occupiedBandwidthHz: normalized.occupiedBandwidthHz,
      offsetModel: normalized.offsetModel,
      sdrTrackingMode,
    };
  }

  private normalizeMode(radioMode: string | null, bandwidthLabel: string | number | null): ModeNormalization {
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
    if (!bandwidthLabel) {
      return 'normal';
    }

    if (typeof bandwidthLabel !== 'string') {
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

  private async resolveTrackingMode(currentFrequency: number | null): Promise<TrackingMode> {
    const activeConnection = this.engine.getRadioManager().getActiveConnection();
    if (activeConnection instanceof HamlibConnection) {
      try {
        const spectrumMode = await activeConnection.getCurrentSpectrumMode();
        const mappedMode = this.mapHamlibSpectrumMode(spectrumMode);
        if (mappedMode !== 'unknown') {
          return mappedMode;
        }
      } catch (error) {
        logger.debug('Failed to read Hamlib spectrum mode', error);
      }
    }

    if (!this.lastRadioFrame || typeof currentFrequency !== 'number') {
      return 'unknown';
    }

    const centerFrequency = typeof this.lastRadioFrame.meta.centerFrequency === 'number' && Number.isFinite(this.lastRadioFrame.meta.centerFrequency)
      ? this.lastRadioFrame.meta.centerFrequency
      : (this.lastRadioFrame.frequencyRange.min + this.lastRadioFrame.frequencyRange.max) / 2;
    const spanHz = this.lastRadioFrame.meta.spanHz ?? Math.abs(this.lastRadioFrame.frequencyRange.max - this.lastRadioFrame.frequencyRange.min);
    if (!Number.isFinite(centerFrequency) || !Number.isFinite(spanHz)) {
      return 'unknown';
    }
    const binWidth = spanHz > 0 ? spanHz / Math.max(this.lastRadioFrame.binaryData.format.length, 1) : 0;
    const threshold = Math.max(50, binWidth * 2);

    return Math.abs(centerFrequency - currentFrequency) <= threshold ? 'follow' : 'fixed';
  }

  private mapHamlibSpectrumMode(mode: string | null): TrackingMode {
    if (mode === null || mode === undefined) {
      return 'unknown';
    }

    const normalized = mode.toLowerCase();
    if (normalized.includes('center') || normalized.includes('cent')) {
      return 'follow';
    }
    if (normalized.includes('fixed')) {
      return 'fixed';
    }
    return 'unknown';
  }

  private areStatesEqual(left: RadioViewState, right: RadioViewState): boolean {
    return left.frequency === right.frequency
      && left.radioMode === right.radioMode
      && left.bandwidthLabel === right.bandwidthLabel
      && left.occupiedBandwidthHz === right.occupiedBandwidthHz
      && left.offsetModel === right.offsetModel
      && left.sdrTrackingMode === right.sdrTrackingMode;
  }
}
