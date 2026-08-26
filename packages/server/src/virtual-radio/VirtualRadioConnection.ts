import { EventEmitter } from 'eventemitter3';
import type { MeterCapabilities } from '@tx5dr/contracts';
import type {
  ApplyOperatingStateRequest,
  ApplyOperatingStateResult,
  IRadioConnection,
  IRadioConnectionEvents,
  RadioConnectionConfig,
  RadioModeBandwidth,
  RadioModeInfo,
  SetRadioModeOptions,
} from '../radio/connections/IRadioConnection.js';
import { RadioConnectionState, RadioConnectionType } from '../radio/connections/IRadioConnection.js';

/** In-memory CAT/PTT endpoint used only after virtual-radio safety validation. */
export class VirtualRadioConnection extends EventEmitter<IRadioConnectionEvents> implements IRadioConnection {
  private state = RadioConnectionState.DISCONNECTED;
  private frequencyHz: number;
  private mode: RadioModeInfo = { mode: 'USB', bandwidth: '' };
  private ptt = false;

  constructor(dialFrequencyHz: number) {
    super();
    this.frequencyHz = dialFrequencyHz;
  }

  getType(): RadioConnectionType { return RadioConnectionType.NONE; }
  getState(): RadioConnectionState { return this.state; }
  isHealthy(): boolean { return this.state === RadioConnectionState.CONNECTED; }
  isCriticalOperationActive(): boolean { return false; }

  async connect(_config: RadioConnectionConfig): Promise<void> {
    this.state = RadioConnectionState.CONNECTED;
    this.emit('stateChanged', this.state);
    this.emit('connected');
  }

  async disconnect(reason?: string): Promise<void> {
    this.ptt = false;
    this.state = RadioConnectionState.DISCONNECTED;
    this.emit('stateChanged', this.state);
    this.emit('disconnected', reason);
  }

  async setFrequency(frequency: number): Promise<void> {
    this.frequencyHz = frequency;
    this.emit('frequencyChanged', frequency);
  }

  async getFrequency(): Promise<number> { return this.frequencyHz; }
  async setPTT(enabled: boolean): Promise<void> { this.ptt = enabled; }
  isPTTEnabled(): boolean { return this.ptt; }

  async setMode(mode: string, bandwidth?: RadioModeBandwidth, _options?: SetRadioModeOptions): Promise<void> {
    this.mode = { mode, bandwidth: bandwidth ?? '' };
  }

  async getMode(): Promise<RadioModeInfo> { return { ...this.mode }; }

  async applyOperatingState(request: ApplyOperatingStateRequest): Promise<ApplyOperatingStateResult> {
    if (request.frequency !== undefined) await this.setFrequency(request.frequency);
    if (request.mode) await this.setMode(request.mode, request.bandwidth, request.options);
    return {
      frequencyApplied: request.frequency !== undefined,
      modeApplied: Boolean(request.mode),
    };
  }

  getMeterCapabilities(): MeterCapabilities {
    return { strength: false, swr: false, alc: false, power: false, powerWatts: false };
  }

  setKnownFrequency(frequencyHz: number): void { this.frequencyHz = frequencyHz; }

  getConnectionInfo() {
    return { type: RadioConnectionType.NONE, state: this.state, config: { type: 'none' as const } };
  }
}
