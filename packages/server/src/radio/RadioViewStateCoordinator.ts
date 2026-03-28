import { EventEmitter } from 'eventemitter3';
import type { RadioViewState } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioViewStateCoordinator');
const MODE_POLL_INTERVAL_MS = 2000;

type OffsetModel = NonNullable<RadioViewState['offsetModel']>;

interface ModeNormalization {
  occupiedBandwidthHz: number | null;
  offsetModel: OffsetModel | null;
}

interface RadioViewStateCoordinatorEvents {
  stateChanged: (state: RadioViewState) => void;
}

const EMPTY_STATE: RadioViewState = {
  frequency: null,
  radioMode: null,
  bandwidthLabel: null,
  occupiedBandwidthHz: null,
  offsetModel: null,
};

export class RadioViewStateCoordinator extends EventEmitter<RadioViewStateCoordinatorEvents> {
  private currentState: RadioViewState = EMPTY_STATE;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly engine: DigitalRadioEngine) {
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
      return EMPTY_STATE;
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

    return {
      frequency: typeof frequency === 'number' ? frequency : null,
      radioMode,
      bandwidthLabel: this.formatBandwidthLabel(bandwidthLabel),
      occupiedBandwidthHz: normalized.occupiedBandwidthHz,
      offsetModel: normalized.offsetModel,
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

  private areStatesEqual(left: RadioViewState, right: RadioViewState): boolean {
    return left.frequency === right.frequency
      && left.radioMode === right.radioMode
      && left.bandwidthLabel === right.bandwidthLabel
      && left.occupiedBandwidthHz === right.occupiedBandwidthHz
      && left.offsetModel === right.offsetModel;
  }
}
