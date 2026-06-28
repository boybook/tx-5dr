import { EventEmitter } from 'eventemitter3';
import {
  TciClient,
  TciError,
  TciSampleType,
  payloadToFloat32,
  float32ToPcm16,
  type TciTxChronoRequest,
  type TciStreamFrame,
} from 'tci-client-node';
import type { MeterCapabilities, TunerCapabilities, TunerStatus } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';
import { createLogger } from '../../utils/logger.js';
import { buildLevelMeterReading, formatSValue } from './meterUtils.js';
import { RadioIoQueue } from './RadioIoQueue.js';
import {
  type ApplyOperatingStateRequest,
  type ApplyOperatingStateResult,
  type IRadioConnection,
  type IRadioConnectionEvents,
  type MeterData,
  type RadioConnectionConfig,
  RadioConnectionState,
  RadioConnectionType,
  type RadioModeBandwidth,
  type RadioModeInfo,
  type SetRadioModeOptions,
} from './IRadioConnection.js';

const logger = createLogger('TciConnection');
const DEFAULT_TCI_PORT = 40001;
const DEFAULT_TCI_AUDIO_RATE = 12_000;
const TCI_COMMAND_TIMEOUT_MS = 1_500;
const TCI_CONNECT_TIMEOUT_MS = 6_000;
const TCI_WRITE_TIMEOUT_MS = 3_000;
const TCI_FREQUENCY_WRITE_SETTLE_MS = 250;
const TCI_TX_STREAM_BUFFERING_MS = 150;

interface TxDrainWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class TciConnection extends EventEmitter<IRadioConnectionEvents> implements IRadioConnection {
  private readonly ioQueue = new RadioIoQueue({ label: 'TCI WebSocket' });
  private ioSessionId = 0;
  private client: TciClient | null = null;
  private currentConfig: RadioConnectionConfig | null = null;
  private state = RadioConnectionState.DISCONNECTED;
  private lastKnownFrequency: number | null = null;
  private lastKnownMode: string | null = null;
  private lastKnownPtt: boolean | null = null;
  private lastRxLevelDbm: number | null = null;
  private lastTxPowerW: number | null = null;
  private lastTxPeakPowerW: number | null = null;
  private lastSWR: number | null = null;
  private audioRunning = false;
  private readonly audioStreamOwners = new Set<string>();
  private txTransmissionActive = false;
  private txAudioChunks: Float32Array[] = [];
  private txAudioChunkOffset = 0;
  private txAudioQueuedSamples = 0;
  private txDrainWaiters: TxDrainWaiter[] = [];

  getType(): RadioConnectionType {
    return RadioConnectionType.TCI;
  }

  getState(): RadioConnectionState {
    return this.state;
  }

  isHealthy(): boolean {
    return this.state === RadioConnectionState.CONNECTED && Boolean(this.client?.isConnected());
  }

  isConnected(): boolean {
    return this.isHealthy();
  }

  isCriticalOperationActive(): boolean {
    return this.ioQueue.isCriticalActive();
  }

  getRadioIoQueueSnapshot() {
    return this.ioQueue.getSnapshot();
  }

  async connect(config: RadioConnectionConfig): Promise<void> {
    if (this.client) {
      await this.disconnect('reconnect');
    }

    if (config.type !== 'tci') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Configuration type error: expected 'tci', got '${config.type}'`,
        userMessage: 'Radio configuration type is incorrect',
        suggestions: ['Select TCI / SunSDR as the radio connection type'],
      });
    }

    const tci = config.tci;
    if (!tci?.host || !tci.port) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'TCI configuration missing required fields: tci.host, tci.port',
        userMessage: 'TCI configuration is incomplete',
        suggestions: ['Enter the ExpertSDR TCI host', 'Enter the TCI WebSocket port (default 40001)'],
      });
    }

    this.currentConfig = config;
    this.ioSessionId += 1;
    this.lastKnownFrequency = null;
    this.lastKnownMode = null;
    this.lastKnownPtt = null;
    this.audioRunning = false;
    this.audioStreamOwners.clear();
    this.txTransmissionActive = false;
    this.clearTxAudioQueue('connect-reset');
    this.setState(RadioConnectionState.CONNECTING);

    const url = `ws://${tci.host}:${tci.port || DEFAULT_TCI_PORT}`;
    const client = new TciClient({
      url,
      receiver: tci.receiver ?? 0,
      trx: tci.trx ?? 0,
      vfo: tci.vfo ?? 0,
      connectTimeoutMs: TCI_CONNECT_TIMEOUT_MS,
      commandTimeoutMs: TCI_COMMAND_TIMEOUT_MS,
      writeAckMode: 'state',
      writeTimeoutMs: TCI_WRITE_TIMEOUT_MS,
      frequencyWriteSettleMs: TCI_FREQUENCY_WRITE_SETTLE_MS,
    });
    this.client = client;
    this.setupClientListeners(client);

    try {
      logger.info('Connecting to TCI radio', { url, receiver: tci.receiver ?? 0, trx: tci.trx ?? 0, vfo: tci.vfo ?? 0 });
      await client.connect();
      await this.waitForReady(client, 2_000).catch((error) => {
        logger.warn('TCI READY was not received before timeout; continuing with open WebSocket', error);
      });
      await client.configureAudio({
        sampleRate: tci.audioSampleRate ?? DEFAULT_TCI_AUDIO_RATE,
        sampleType: TciSampleType.FLOAT32,
        channels: 1,
        samplesPerFrame: 512,
        txBufferingMs: TCI_TX_STREAM_BUFFERING_MS,
      });
      await client.setRxSensorsEnabled(true, 300).catch((error) => logger.debug('Failed to enable TCI RX sensors', error));
      await client.setTxSensorsEnabled(true, 300).catch((error) => logger.debug('Failed to enable TCI TX sensors', error));

      const state = client.getState();
      this.lastKnownFrequency = state.frequencies[`${tci.receiver ?? 0}:${tci.vfo ?? 0}`] ?? null;
      this.lastKnownMode = state.modes[`${tci.receiver ?? 0}:${tci.vfo ?? 0}`] ?? null;
      this.lastKnownPtt = typeof state.ptt[String(tci.trx ?? 0)] === 'boolean'
        ? state.ptt[String(tci.trx ?? 0)]
        : null;

      this.setState(RadioConnectionState.CONNECTED);
      this.emit('connected');
      logger.info('TCI radio connected successfully', { device: state.device, protocol: state.protocol });
    } catch (error) {
      await this.cleanup();
      this.setState(RadioConnectionState.ERROR);
      throw this.convertError(error, 'connect');
    }
  }

  async disconnect(reason?: string): Promise<void> {
    logger.info(`Disconnecting TCI radio: ${reason || 'no reason'}`);
    this.ioSessionId += 1;
    await this.cleanup();
    this.setState(RadioConnectionState.DISCONNECTED);
    this.emit('disconnected', reason);
  }

  async setFrequency(frequency: number): Promise<void> {
    await this.runTask('setFrequency', async () => {
      this.checkConnected();
      const targetFrequency = Math.round(frequency);
      if (this.isFrequencyAlreadyApplied(targetFrequency)) {
        logger.debug('TCI state matched before write', { operation: 'setFrequency', frequency: targetFrequency });
        this.lastKnownFrequency = targetFrequency;
        return;
      }
      await this.client!.setFrequency(targetFrequency);
      this.lastKnownFrequency = targetFrequency;
      this.emit('frequencyChanged', targetFrequency);
    }, { critical: true });
  }

  async getFrequency(): Promise<number> {
    return this.runTask('getFrequency', async () => {
      this.checkConnected();
      const frequency = await this.client!.getFrequency();
      if (typeof frequency === 'number' && Number.isFinite(frequency) && frequency > 0) {
        this.lastKnownFrequency = frequency;
        return frequency;
      }
      if (this.lastKnownFrequency !== null) {
        return this.lastKnownFrequency;
      }
      throw new Error('TCI frequency read returned no value');
    }, { id: 'getFrequency' });
  }

  async setPTT(enabled: boolean): Promise<void> {
    await this.runTask('setPTT', async () => {
      this.checkConnected();
      if (!enabled) {
        this.clearTxAudioQueue('ptt-off');
      }
      if (this.isPttAlreadyApplied(enabled)) {
        logger.debug('TCI state matched before write', { operation: 'setPTT', ptt: enabled });
        this.lastKnownPtt = enabled;
        return;
      }
      await this.client!.setPtt(enabled, { source: enabled ? 'tci' : undefined });
      this.lastKnownPtt = enabled;
      if (!enabled) {
        this.clearTxAudioQueue('ptt-off-applied');
      }
    }, { critical: true });
  }

  async getPTT(): Promise<boolean> {
    return this.runTask('getPTT', async () => {
      this.checkConnected();
      const ptt = await this.client!.getPtt();
      if (typeof ptt === 'boolean') {
        this.lastKnownPtt = ptt;
      }
      return this.lastKnownPtt ?? false;
    }, { id: 'getPTT' });
  }

  async setMode(mode: string, _bandwidth?: RadioModeBandwidth, options?: SetRadioModeOptions): Promise<void> {
    await this.runTask('setMode', async () => {
      this.checkConnected();
      const tciMode = this.normalizeMode(mode, options);
      if (this.isModeAlreadyApplied(tciMode)) {
        logger.debug('TCI state matched before write', { operation: 'setMode', mode: tciMode });
        this.lastKnownMode = tciMode.toLowerCase();
        return;
      }
      await this.client!.setMode(tciMode);
      this.lastKnownMode = tciMode.toLowerCase();
    }, { critical: true });
  }

  async applyOperatingState(request: ApplyOperatingStateRequest): Promise<ApplyOperatingStateResult> {
    return this.runTask('applyOperatingState', async () => {
      this.checkConnected();
      let frequencyApplied = false;
      let modeApplied = false;
      let modeError: Error | undefined;

      if (request.frequency !== undefined) {
        const targetFrequency = Math.round(request.frequency);
        if (this.isFrequencyAlreadyApplied(targetFrequency)) {
          logger.debug('TCI state matched before write', { operation: 'applyOperatingState.setFrequency', frequency: targetFrequency });
          this.lastKnownFrequency = targetFrequency;
          frequencyApplied = true;
        } else {
          try {
            await this.client!.setFrequency(targetFrequency);
            this.lastKnownFrequency = targetFrequency;
            this.emit('frequencyChanged', targetFrequency);
            frequencyApplied = true;
          } catch (error) {
            if (!isTciCommandTimeout(error)) {
              throw error;
            }
            logger.warn('TCI write timeout tolerated', {
              operation: 'applyOperatingState.setFrequency',
              frequency: targetFrequency,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (request.mode) {
        try {
          const tciMode = this.normalizeMode(request.mode, request.options);
          if (this.isModeAlreadyApplied(tciMode)) {
            logger.debug('TCI state matched before write', { operation: 'applyOperatingState.setMode', mode: tciMode });
            this.lastKnownMode = tciMode.toLowerCase();
            modeApplied = true;
          } else {
            await this.client!.setMode(tciMode);
            this.lastKnownMode = tciMode.toLowerCase();
            modeApplied = true;
          }
        } catch (error) {
          if (isTciCommandTimeout(error)) {
            logger.warn('TCI write timeout tolerated', {
              operation: 'applyOperatingState.setMode',
              mode: request.mode,
              error: error instanceof Error ? error.message : String(error),
            });
            modeError = this.convertError(error, 'applyOperatingState.setMode');
          } else if (!request.tolerateModeFailure) {
            throw error;
          } else {
            modeError = error instanceof Error ? error : new Error(String(error));
          }
        }
      }

      return { frequencyApplied, modeApplied, modeError };
    }, { critical: true });
  }

  async getMode(): Promise<RadioModeInfo> {
    return this.runTask('getMode', async () => {
      this.checkConnected();
      const mode = await this.client!.getMode();
      if (mode) {
        this.lastKnownMode = mode;
      }
      return { mode: (mode ?? this.lastKnownMode ?? 'UNKNOWN').toUpperCase(), bandwidth: 'Normal' };
    }, { id: 'getMode' });
  }

  async getSupportedModes(): Promise<string[]> {
    const modes = this.client?.getState().modulations ?? [];
    return modes.length > 0 ? modes.map((mode) => mode.toUpperCase()) : ['LSB', 'USB', 'CW', 'AM', 'NFM', 'DIGU', 'DIGL'];
  }

  supportsCWMessageKeyer(): boolean {
    return true;
  }

  async sendCWMessage(message: string, _wpm: number): Promise<void> {
    await this.runTask('sendCWMessage', async () => {
      this.checkConnected();
      await this.client!.sendCwMessage(message);
    }, { critical: true });
  }

  async stopCWMessage(): Promise<void> {
    await this.runTask('stopCWMessage', async () => {
      if (!this.client?.isConnected()) {
        return;
      }
      await this.client.stopCw();
    }, { critical: true });
  }

  getMeterCapabilities(): MeterCapabilities {
    return { strength: true, swr: true, alc: false, power: true, powerWatts: true };
  }

  async getTunerCapabilities(): Promise<TunerCapabilities> {
    return { supported: false, hasSwitch: false, hasManualTune: false };
  }

  async getTunerStatus(): Promise<TunerStatus> {
    return { enabled: false, active: false, status: 'idle' };
  }

  async setSplitEnabled(enabled: boolean): Promise<void> {
    await this.runTask('setSplitEnabled', async () => {
      this.checkConnected();
      await this.client!.setSplit(enabled);
    }, { critical: true });
  }

  async getSplitEnabled(): Promise<boolean> {
    const trx = this.currentConfig?.tci?.trx ?? 0;
    return this.client?.getState().split[String(trx)] ?? false;
  }

  async setRFPower(value: number): Promise<void> {
    await this.runTask('setRFPower', async () => {
      this.checkConnected();
      await this.client!.setDrive(Math.round(Math.max(0, Math.min(1, value)) * 100));
    }, { critical: true });
  }

  async getRFPower(): Promise<number> {
    const trx = this.currentConfig?.tci?.trx ?? 0;
    const drive = this.client?.getState().drive[String(trx)];
    if (typeof drive === 'number') {
      return Math.max(0, Math.min(1, drive / 100));
    }
    throw new Error('TCI drive level is not available yet');
  }

  setKnownFrequency(frequencyHz: number): void {
    if (Number.isFinite(frequencyHz) && frequencyHz > 0) {
      this.lastKnownFrequency = frequencyHz;
    }
  }

  getConnectionInfo() {
    return {
      type: this.getType(),
      state: this.getState(),
      config: {
        type: this.currentConfig?.type,
        tci: this.currentConfig?.tci,
      },
    };
  }

  getAudioSampleRate(): number {
    return this.currentConfig?.tci?.audioSampleRate ?? DEFAULT_TCI_AUDIO_RATE;
  }

  async startAudioStream(owner = 'rx'): Promise<void> {
    this.checkConnected();
    this.audioStreamOwners.add(owner);
    if (this.audioRunning) {
      return;
    }
    try {
      await this.client!.startAudio(this.currentConfig?.tci?.receiver ?? 0);
      this.audioRunning = true;
    } catch (error) {
      this.audioStreamOwners.delete(owner);
      throw error;
    }
  }

  async stopAudioStream(owner = 'rx'): Promise<void> {
    this.audioStreamOwners.delete(owner);
    if (this.audioStreamOwners.size > 0) {
      return;
    }
    if (!this.client?.isConnected() || !this.audioRunning) {
      this.audioRunning = false;
      return;
    }
    await this.client.stopAudio(this.currentConfig?.tci?.receiver ?? 0);
    this.audioRunning = false;
  }

  async sendAudio(samples: Float32Array): Promise<void> {
    this.checkConnected();
    this.enqueueTxAudio(samples);
  }

  beginTxAudio(): void {
    this.txTransmissionActive = true;
    this.clearTxAudioQueue('tx-begin');
  }

  async waitForTxAudioDrain(timeoutMs: number): Promise<void> {
    if (this.txAudioQueuedSamples <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: TxDrainWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.txDrainWaiters = this.txDrainWaiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for TCI TX audio drain (${this.txAudioQueuedSamples} samples queued)`));
        }, timeoutMs),
      };
      this.txDrainWaiters.push(waiter);
    });
  }

  endTxAudio(): void {
    this.txTransmissionActive = false;
    this.clearTxAudioQueue('tx-end');
  }

  private setupClientListeners(client: TciClient): void {
    client.on('disconnected', (reason) => {
      if (this.client !== client) return;
      this.setState(RadioConnectionState.DISCONNECTED);
      this.emit('disconnected', reason instanceof Error ? reason.message : String(reason ?? 'TCI disconnected'));
    });
    client.on('error', (error) => this.emit('error', this.convertError(error, 'event')));
    client.on('state', () => this.syncStateFromClient());
    client.on('rxAudioFrame', (frame) => this.handleRxAudioFrame(frame));
    client.on('txChrono', (request) => {
      if (this.client !== client) return;
      this.handleTxChrono(request);
    });
  }

  private syncStateFromClient(): void {
    if (!this.client) return;
    const tci = this.currentConfig?.tci;
    const state = this.client.getState();
    const rxKey = `${tci?.receiver ?? 0}:${tci?.vfo ?? 0}`;
    const trxKey = String(tci?.trx ?? 0);
    const frequency = state.frequencies[rxKey];
    if (typeof frequency === 'number' && frequency > 0 && frequency !== this.lastKnownFrequency) {
      this.lastKnownFrequency = frequency;
      this.emit('frequencyChanged', frequency);
    }
    const mode = state.modes[rxKey];
    if (mode) {
      this.lastKnownMode = mode;
    }
    if (typeof state.ptt[trxKey] === 'boolean') {
      this.lastKnownPtt = state.ptt[trxKey];
    }

    this.updateMetersFromState(state.rxSensors, state.txSensors);
  }

  private updateMetersFromState(
    rxSensors: Record<string, Record<string, number | string | boolean>>,
    txSensors: Record<string, Record<string, number | string | boolean>>,
  ): void {
    const tci = this.currentConfig?.tci;
    const rxKey = `${tci?.receiver ?? 0}:${tci?.vfo ?? 0}`;
    const rx = rxSensors[rxKey] ?? rxSensors[String(tci?.receiver ?? 0)];
    const tx = txSensors[String(tci?.trx ?? 0)];
    const levelDbm = toNumber(rx?.levelDbm);
    const rmsPower = toNumber(tx?.rmsPowerW);
    const peakPower = toNumber(tx?.peakPowerW);
    const swr = toNumber(tx?.swr);
    let changed = false;

    if (levelDbm !== undefined) {
      this.lastRxLevelDbm = levelDbm;
      changed = true;
    }
    if (rmsPower !== undefined) {
      this.lastTxPowerW = rmsPower;
      changed = true;
    }
    if (peakPower !== undefined) {
      this.lastTxPeakPowerW = peakPower;
      changed = true;
    }
    if (swr !== undefined) {
      this.lastSWR = swr;
      changed = true;
    }

    if (changed) {
      this.emit('meterData', this.buildMeterData());
    }
  }

  private buildMeterData(): MeterData {
    const frequency = this.lastKnownFrequency ?? 14_000_000;
    const s9Dbm = frequency < 30_000_000 ? -73 : -93;
    const dbOffset = (this.lastRxLevelDbm ?? s9Dbm) - s9Dbm;
    const level = this.lastRxLevelDbm === null
      ? null
      : buildLevelMeterReading(this.lastRxLevelDbm, dbOffset, frequency, 's-meter-dbm', formatSValue(dbOffset));
    const powerWatts = this.lastTxPowerW ?? this.lastTxPeakPowerW;
    const powerPercent = powerWatts === null || powerWatts === undefined ? 0 : Math.max(0, Math.min(100, powerWatts));
    return {
      swr: this.lastSWR === null ? null : { raw: this.lastSWR, swr: this.lastSWR, alert: this.lastSWR >= 2.5 },
      alc: null,
      level,
      power: powerWatts === null || powerWatts === undefined
        ? null
        : { raw: powerWatts, percent: powerPercent, watts: powerWatts, maxWatts: null },
    };
  }

  private handleRxAudioFrame(frame: TciStreamFrame): void {
    try {
      const samples = payloadToFloat32(frame);
      this.emit('audioFrame', float32ToPcm16(samples), { timestampMs: Date.now() });
    } catch (error) {
      this.emit('error', this.convertError(error, 'rxAudioFrame'));
    }
  }

  private handleTxChrono(request: TciTxChronoRequest): void {
    try {
      const channels = Math.max(1, Math.floor(request.channels || 1));
      const requestedSamples = Math.max(0, Math.floor(request.sampleCount) * channels);
      const { samples, copied } = this.dequeueTxAudio(requestedSamples);
      if (copied < requestedSamples) {
        logger.debug('TCI TX chrono underflow; sending silence for missing samples', {
          requestedSamples,
          copied,
          queuedSamples: this.txAudioQueuedSamples,
          active: this.txTransmissionActive,
        });
      }
      this.client?.sendTxAudioForChrono(request, samples);
    } catch (error) {
      this.emit('error', this.convertError(error, 'txChrono'));
    }
  }

  private enqueueTxAudio(samples: Float32Array): void {
    if (samples.length <= 0) {
      return;
    }
    const copy = new Float32Array(samples);
    this.txAudioChunks.push(copy);
    this.txAudioQueuedSamples += copy.length;
  }

  private dequeueTxAudio(sampleCount: number): { samples: Float32Array; copied: number } {
    const output = new Float32Array(Math.max(0, sampleCount));
    let copied = 0;
    while (copied < output.length && this.txAudioChunks.length > 0) {
      const chunk = this.txAudioChunks[0]!;
      const available = chunk.length - this.txAudioChunkOffset;
      const take = Math.min(output.length - copied, available);
      output.set(chunk.subarray(this.txAudioChunkOffset, this.txAudioChunkOffset + take), copied);
      copied += take;
      this.txAudioChunkOffset += take;
      this.txAudioQueuedSamples = Math.max(0, this.txAudioQueuedSamples - take);
      if (this.txAudioChunkOffset >= chunk.length) {
        this.txAudioChunks.shift();
        this.txAudioChunkOffset = 0;
      }
    }
    this.resolveTxDrainWaitersIfDrained();
    return { samples: output, copied };
  }

  private clearTxAudioQueue(reason: string): void {
    if (this.txAudioQueuedSamples > 0 || this.txAudioChunks.length > 0) {
      logger.debug('Clearing TCI TX audio queue', { reason, queuedSamples: this.txAudioQueuedSamples });
    }
    this.txAudioChunks = [];
    this.txAudioChunkOffset = 0;
    this.txAudioQueuedSamples = 0;
    this.resolveTxDrainWaitersIfDrained();
  }

  private resolveTxDrainWaitersIfDrained(): void {
    if (this.txAudioQueuedSamples > 0 || this.txDrainWaiters.length === 0) {
      return;
    }
    const waiters = this.txDrainWaiters;
    this.txDrainWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectTxDrainWaiters(error: Error): void {
    const waiters = this.txDrainWaiters;
    this.txDrainWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async cleanup(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.audioRunning = false;
    this.audioStreamOwners.clear();
    this.txTransmissionActive = false;
    this.rejectTxDrainWaiters(new Error('TCI connection closed before TX audio drained'));
    this.clearTxAudioQueue('cleanup');
    if (client) {
      client.removeAllListeners();
      await client.disconnect().catch((error) => logger.debug('TCI disconnect cleanup failed', error));
    }
  }

  private checkConnected(): void {
    if (!this.client?.isConnected() || this.state !== RadioConnectionState.CONNECTED) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: `TCI connection is not connected (state=${this.state})`,
        userMessage: 'TCI radio is not connected',
        severity: RadioErrorSeverity.WARNING,
      });
    }
  }

  private async runTask<T>(
    name: string,
    task: () => Promise<T>,
    options: { id?: string; critical?: boolean } = {},
  ): Promise<T> {
    return this.ioQueue.run({ sessionId: this.ioSessionId, name, id: options.id, critical: options.critical }, async () => {
      try {
        return await task();
      } catch (error) {
        throw this.convertError(error, name);
      }
    });
  }

  private setState(state: RadioConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.emit('stateChanged', state);
  }

  private waitForReady(client: TciClient, timeoutMs: number): Promise<void> {
    if (client.getState().ready) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('TCI READY timeout'));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.off('ready', onReady);
      };
      client.once('ready', onReady);
    });
  }

  private normalizeMode(mode: string, options?: SetRadioModeOptions): string {
    const upper = mode.trim().toUpperCase();
    if (upper === 'FT8' || upper === 'FT4') return 'DIGU';
    if (['USB-D', 'USB-DATA', 'PKTUSB', 'DATA-U', 'DIGU'].includes(upper)) return 'DIGU';
    if (['LSB-D', 'LSB-DATA', 'PKTLSB', 'DATA-L', 'DIGL'].includes(upper)) return 'DIGL';
    if (options?.intent === 'digital' && upper === 'USB') return 'DIGU';
    if (options?.intent === 'digital' && upper === 'LSB') return 'DIGL';
    return upper;
  }

  private isFrequencyAlreadyApplied(frequency: number): boolean {
    if (this.isSameFrequency(this.lastKnownFrequency, frequency)) {
      return true;
    }
    const tci = this.currentConfig?.tci;
    const stateFrequency = this.client?.getState().frequencies[`${tci?.receiver ?? 0}:${tci?.vfo ?? 0}`];
    return this.isSameFrequency(stateFrequency, frequency);
  }

  private isModeAlreadyApplied(mode: string): boolean {
    const normalized = mode.toLowerCase();
    if (this.lastKnownMode?.toLowerCase() === normalized) {
      return true;
    }
    const tci = this.currentConfig?.tci;
    return this.client?.getState().modes[`${tci?.receiver ?? 0}:${tci?.vfo ?? 0}`]?.toLowerCase() === normalized;
  }

  private isPttAlreadyApplied(enabled: boolean): boolean {
    if (this.lastKnownPtt === enabled) {
      return true;
    }
    const trx = this.currentConfig?.tci?.trx ?? 0;
    return this.client?.getState().ptt[String(trx)] === enabled;
  }

  private isSameFrequency(left: number | null | undefined, right: number | null | undefined): boolean {
    return typeof left === 'number'
      && typeof right === 'number'
      && Number.isFinite(left)
      && Number.isFinite(right)
      && Math.round(left) === Math.round(right);
  }

  private convertError(error: unknown, operation: string): RadioError {
    if (error instanceof RadioError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const isTciError = error instanceof TciError;
    const isWriteTimeout = isTciCommandTimeout(error) && isTciWriteOperation(operation);
    const code = isTciError && error.code === 'connect-timeout'
      ? RadioErrorCode.CONNECTION_TIMEOUT
      : isTciError && (error.code === 'not-connected' || error.code === 'disconnected')
        ? RadioErrorCode.CONNECTION_LOST
        : isTciError && error.code === 'command-timeout'
          ? RadioErrorCode.OPERATION_TIMEOUT
          : message.toLowerCase().includes('timeout')
            ? RadioErrorCode.OPERATION_TIMEOUT
            : RadioErrorCode.WEBSOCKET_ERROR;
    return new RadioError({
      code,
      message: `TCI ${operation} failed: ${message}`,
      userMessage: 'TCI radio operation failed',
      severity: isWriteTimeout ? RadioErrorSeverity.WARNING : RadioErrorSeverity.ERROR,
      suggestions: [
        'Check that ExpertSDR/SunSDR TCI server is enabled',
        'Confirm the TCI host and port are reachable',
        'Avoid connecting multiple TCI clients if the radio rejects them',
      ],
      cause: error,
      context: { operation, protocol: 'tci', writeTimeout: isWriteTimeout, recoverable: isWriteTimeout },
    });
  }
}

function isTciCommandTimeout(error: unknown): boolean {
  return error instanceof TciError && error.code === 'command-timeout';
}

function isTciWriteOperation(operation: string): boolean {
  return operation === 'setFrequency'
    || operation === 'setPTT'
    || operation === 'setMode'
    || operation === 'applyOperatingState'
    || operation.startsWith('applyOperatingState.');
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
