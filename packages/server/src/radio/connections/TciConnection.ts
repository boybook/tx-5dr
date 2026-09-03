import { EventEmitter } from 'eventemitter3';
import { performance } from 'node:perf_hooks';
import {
  TciClient,
  TciError,
  TciSampleType,
  TciTxAudioSync,
  normalizeSampleType,
  payloadToFloat32,
  float32ToPcm16,
  type TciTxAudioSyncSnapshot,
  type TciTxChronoRequest,
  type TciStreamFrame,
  type TciHandshakeResult,
  type TciClientOptions,
  type TciIqCapabilities,
  type TciMeterStreamSession,
  type TciRxMeterFrame,
  type TciTxMeterFrame,
} from 'tci-client-node';
import type { MeterCapabilities, TciSpectrumSettings, TunerCapabilities, TunerStatus } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';
import { createLogger } from '../../utils/logger.js';
import { buildLevelMeterReading, formatSValue } from './meterUtils.js';
import { RadioIoQueue } from './RadioIoQueue.js';
import { ConfigManager } from '../../config/config-manager.js';
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
  type RadioWriteResult,
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
const TCI_METER_INTERVAL_MS = 300;
const TCI_METER_MIN_FRESHNESS_MS = 1_000;
const TCI_AUDIO_NEGOTIATION_COMMANDS = new Set([
  'audio_samplerate',
  'audio_stream_sample_type',
  'audio_stream_channels',
  'audio_stream_samples',
  'tx_stream_audio_buffering',
]);

export class TciConnection extends EventEmitter<IRadioConnectionEvents> implements IRadioConnection {
  private readonly ioQueue = new RadioIoQueue({ label: 'TCI WebSocket' });
  private ioSessionId = 0;
  private client: TciClient | null = null;
  private currentConfig: RadioConnectionConfig | null = null;
  private state = RadioConnectionState.DISCONNECTED;
  private lastKnownFrequency: number | null = null;
  private lastKnownMode: string | null = null;
  private lastKnownPtt: boolean | null = null;
  // A state-ack timeout means the TRX command may already be in flight. Do
  // not allow a later lease to reuse this session and apply an old ON/OFF.
  private pttWriteUncertain = false;
  private backgroundTasksStarted = false;
  private meterSession: TciMeterStreamSession | null = null;
  private meterFreshnessMs = Math.max(TCI_METER_MIN_FRESHNESS_MS, TCI_METER_INTERVAL_MS * 4);
  private meterExpiryTimer: NodeJS.Timeout | null = null;
  private meterCapabilities: MeterCapabilities = createEmptyMeterCapabilities();
  private meterInvalidFrameCount = 0;
  private meterExpiryCount = 0;
  private lastRxMeterFrameAtMs = 0;
  private lastTxMeterFrameAtMs = 0;
  private rxMeterIntervalLogged = false;
  private txMeterIntervalLogged = false;
  private lastRxLevelDbm: number | null = null;
  private lastRxLevelAtMs = 0;
  private lastTxPowerW: number | null = null;
  private lastTxPowerAtMs = 0;
  private lastSWR: number | null = null;
  private lastSwrAtMs = 0;
  private lastAlc: MeterData['alc'] = null;
  private lastAlcAtMs = 0;
  private lastDrivePercent: number | null = null;
  private handshakeResult: TciHandshakeResult | null = null;
  private connectedUrl: string | null = null;
  private audioRunning = false;
  private readonly audioStreamOwners = new Set<string>();
  private txAudioSync: TciTxAudioSync | null = null;
  private txChronoTraceLogged = false;
  private txFallbackChronoCount = 0;
  private txFallbackRequestedSamples = 0;
  private txFallbackCopiedSamples = 0;
  private txFallbackMissingSamples = 0;
  private readonly options: { writeTimeoutMs?: number };
  private tciIqSpectrumController: {
    getSupportedSpans(): Promise<readonly number[]>;
    getCurrentSpan(): Promise<number | null>;
    setSpan(spanHz: number): Promise<number>;
    isActive?: () => boolean;
    getTciSpectrumSettings?: () => TciSpectrumSettings;
    setTciSpectrumSettings?: (settings: TciSpectrumSettings) => Promise<TciSpectrumSettings>;
  } | null = null;
  private tciRxFilterBandReadPromise: Promise<[number, number] | null> | null = null;

  constructor(options: { writeTimeoutMs?: number } = {}) {
    super();
    this.options = options;
  }

  getType(): RadioConnectionType {
    return RadioConnectionType.TCI;
  }

  getState(): RadioConnectionState {
    return this.state;
  }

  isHealthy(): boolean {
    return this.state === RadioConnectionState.CONNECTED
      && !this.pttWriteUncertain
      && Boolean(this.client?.isConnected());
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
    this.lastDrivePercent = null;
    this.resetMeterState();
    this.backgroundTasksStarted = false;
    this.handshakeResult = null;
    this.connectedUrl = null;
    this.pttWriteUncertain = false;
    this.audioRunning = false;
    this.audioStreamOwners.clear();
    this.resetTxAudioSync('connect');
    this.setState(RadioConnectionState.CONNECTING);

    try {
      let client: TciClient | null = null;
      let handshake: TciHandshakeResult | null = null;
      let connectedUrl: string | null = null;
      let lastError: unknown;
      for (const url of resolveTciEndpointCandidates(tci)) {
        const candidate = new TciClient({
          url,
          receiver: tci.receiver ?? 0,
          trx: tci.trx ?? 0,
          vfo: tci.vfo ?? 0,
          connectTimeoutMs: TCI_CONNECT_TIMEOUT_MS,
          handshakeTimeoutMs: 10_000,
          commandTimeoutMs: TCI_COMMAND_TIMEOUT_MS,
          writeAckMode: 'state',
          writeTimeoutMs: this.options.writeTimeoutMs ?? TCI_WRITE_TIMEOUT_MS,
          frequencyWriteSettleMs: TCI_FREQUENCY_WRITE_SETTLE_MS,
          dialect: tci.dialect ?? 'auto',
        });
        try {
          logger.info('Connecting to TCI radio candidate', {
            url,
            dialect: tci.dialect ?? 'auto',
            receiver: tci.receiver ?? 0,
            trx: tci.trx ?? 0,
            vfo: tci.vfo ?? 0,
          });
          handshake = await candidate.connect();
          client = candidate;
          connectedUrl = url;
          break;
        } catch (error) {
          lastError = error;
          logger.warn('TCI endpoint candidate failed', {
            url,
            code: error instanceof TciError ? error.code : undefined,
            error: error instanceof Error ? error.message : String(error),
          });
          candidate.removeAllListeners();
          await candidate.disconnect().catch(() => undefined);
        }
      }
      if (!client || !handshake || !connectedUrl) throw lastError ?? new Error('No TCI endpoint candidate succeeded');
      this.client = client;
      this.setupClientListeners(client);
      this.connectedUrl = connectedUrl;
      this.handshakeResult = handshake;
      await client.configureAudio({
        sampleRate: tci.audioSampleRate ?? DEFAULT_TCI_AUDIO_RATE,
        sampleType: TciSampleType.FLOAT32,
        channels: 1,
        samplesPerFrame: 512,
        txBufferingMs: TCI_TX_STREAM_BUFFERING_MS,
      });
      const state = client.getState();
      this.lastKnownFrequency = state.frequencies[`${tci.receiver ?? 0}:${tci.vfo ?? 0}`] ?? null;
      this.lastKnownMode = state.modes[`${tci.receiver ?? 0}:${tci.vfo ?? 0}`] ?? null;
      this.lastKnownPtt = typeof state.ptt[String(tci.trx ?? 0)] === 'boolean'
        ? state.ptt[String(tci.trx ?? 0)]
        : null;
      this.lastDrivePercent = state.drive[String(tci.trx ?? 0)] ?? null;

      this.setState(RadioConnectionState.CONNECTED);
      this.emit('connected');
      logger.info('TCI radio connected successfully', {
        device: handshake.identity.device,
        protocolName: handshake.identity.programName,
        protocolVersion: handshake.identity.protocolVersion,
        dialect: handshake.dialect.dialect.id,
        confidence: handshake.dialect.confidence,
        warnings: handshake.dialect.warnings,
        endpoint: connectedUrl,
      });
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
    this.pttWriteUncertain = false;
    this.setState(RadioConnectionState.DISCONNECTED);
    this.emit('disconnected', reason);
  }

  startBackgroundTasks(): void {
    if (this.backgroundTasksStarted) return;
    this.backgroundTasksStarted = true;
    const sessionId = this.ioSessionId;
    void this.startMeterStream(sessionId).catch((error) => {
      if (sessionId !== this.ioSessionId) return;
      logger.debug('TCI meter stream start failed', error);
    });
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

  async setDdsFrequency(frequency: number, receiver = this.currentConfig?.tci?.receiver ?? 0): Promise<void> {
    await this.runTask('setDdsFrequency', async () => {
      this.checkConnected();
      const targetFrequency = Math.round(frequency);
      if (!Number.isFinite(targetFrequency) || targetFrequency < 0 || !Number.isInteger(receiver) || receiver < 0) {
        throw new Error(`Invalid TCI DDS frequency: ${frequency}`);
      }
      logger.info('TCI DDS center-frequency write started', {
        receiver,
        frequencyHz: targetFrequency,
      });
      await this.client!.setDdsFrequency(targetFrequency, receiver);
      logger.info('TCI DDS center-frequency write completed', {
        receiver,
        frequencyHz: targetFrequency,
      });
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
      if (this.pttWriteUncertain) {
        throw new RadioError({
          code: RadioErrorCode.OPERATION_TIMEOUT,
          message: 'TCI PTT state is uncertain; reconnect before issuing another PTT command',
          userMessage: 'TCI PTT state is uncertain. Reconnect the radio before transmitting again.',
          severity: RadioErrorSeverity.CRITICAL,
          context: { operation: 'setPTT', protocol: 'tci', stateUncertain: true },
        });
      }
      this.checkConnected();
      if (!enabled) {
        this.resetTxAudioSync('ptt-off');
      }
      if (this.isPttAlreadyApplied(enabled)) {
        logger.debug('TCI state matched before write', { operation: 'setPTT', ptt: enabled });
        this.lastKnownPtt = enabled;
        if (!enabled) this.clearTxMeterData(true);
        return;
      }
      try {
        await this.client!.setPtt(enabled, { source: enabled ? 'tci' : undefined });
      } catch (error) {
        if (isTciCommandTimeout(error)) {
          this.pttWriteUncertain = true;
          this.lastKnownPtt = null;
          this.setState(RadioConnectionState.ERROR);
          logger.error('TCI PTT state acknowledgement timed out; poisoning session', {
            enabled,
            operation: 'setPTT',
          });
        }
        throw error;
      }
      this.lastKnownPtt = enabled;
      if (!enabled) {
        this.resetTxAudioSync('ptt-off');
        this.clearTxMeterData(true);
      }
    }, { critical: true });
  }

  async getPTT(): Promise<boolean> {
    return this.runTask('getPTT', async () => {
      this.checkConnected();
      const ptt = await this.client!.getPtt();
      if (typeof ptt === 'boolean') {
        this.lastKnownPtt = ptt;
        if (!ptt) this.clearTxMeterData(true);
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
    return { ...this.meterCapabilities };
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

  async setRFPower(value: number): Promise<RadioWriteResult<number>> {
    return this.runTask('setRFPower', async () => {
      this.checkConnected();
      const requested = Math.max(0, Math.min(1, value));
      const result = await this.client!.setDriveWithResult(Math.round(requested * 100));
      const applied = Math.max(0, Math.min(1, result.applied / 100));
      this.lastDrivePercent = result.applied;
      return {
        requested,
        applied,
        outcome: result.outcome,
        acknowledgement: result.acknowledgement,
      };
    }, { critical: true });
  }

  async getRFPower(): Promise<number> {
    return this.runTask('getRFPower', async () => {
      this.checkConnected();
      const trx = this.currentConfig?.tci?.trx ?? 0;
      const drive = await this.client!.getDrive(trx);
      if (typeof drive !== 'number') throw new Error('TCI drive level is not available');
      this.lastDrivePercent = drive;
      return Math.max(0, Math.min(1, drive / 100));
    }, { id: 'getRFPower' });
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
      diagnostics: this.handshakeResult ? {
        endpoint: this.connectedUrl,
        device: this.handshakeResult.identity.device,
        protocolName: this.handshakeResult.identity.programName,
        protocolVersion: this.handshakeResult.identity.protocolVersion,
        dialect: this.handshakeResult.dialect.dialect.id,
        confidence: this.handshakeResult.dialect.confidence,
        warnings: this.handshakeResult.dialect.warnings,
      } : undefined,
    };
  }

  registerTciIqSpectrumController(controller: {
    getSupportedSpans(): Promise<readonly number[]>;
    getCurrentSpan(): Promise<number | null>;
    setSpan(spanHz: number): Promise<number>;
  }): void {
    this.tciIqSpectrumController = controller;
  }

  unregisterTciIqSpectrumController(controller: object): void {
    if (this.tciIqSpectrumController === controller) {
      this.tciIqSpectrumController = null;
    }
  }

  async getTciIqSampleRates(): Promise<number[]> {
    // Capability negotiation must expose the protocol's actual IQ sample-rate
    // options.  The spectrum controller's `getSupportedSpans()` is a view
    // concern (it may reject rates that cannot satisfy a local display window),
    // so using it here would make the radio capability panel advertise an
    // incomplete and session-dependent set of values.
    const rates = this.getTciIqSupport().supportedSampleRates;
    return Array.from(new Set(rates.filter((rate) => Number.isFinite(rate) && rate > 0))).sort((a, b) => a - b);
  }

  async getTciIqSampleRate(): Promise<number | null> {
    const current = await this.tciIqSpectrumController?.getCurrentSpan().catch(() => null);
    if (typeof current === 'number' && Number.isFinite(current) && current > 0) return current;
    const configured = ConfigManager.getInstance().getTciIqSampleRate();
    if (configured !== null) return configured;
    const observed = this.getTciIqSupport().currentSampleRate;
    return typeof observed === 'number' && Number.isFinite(observed) && observed > 0 ? observed : null;
  }

  async setTciIqSampleRate(sampleRate: number): Promise<number> {
    const supported = await this.getTciIqSampleRates();
    const requested = Math.round(sampleRate);
    if (!supported.includes(requested)) throw new Error(`Unsupported TCI IQ sample rate: ${sampleRate}`);
    if (!this.tciIqSpectrumController || this.tciIqSpectrumController.isActive?.() === false) {
      // Persist the desired global rate even while the optional spectrum
      // stream is stopped. The next source start will negotiate it with TCI.
      await ConfigManager.getInstance().updateTciIqSampleRate(requested);
      return requested;
    }
    const applied = await this.tciIqSpectrumController.setSpan(requested);
    await ConfigManager.getInstance().updateTciIqSampleRate(applied);
    return applied;
  }

  async getTciSpectrumSettings(): Promise<TciSpectrumSettings> {
    return this.tciIqSpectrumController?.getTciSpectrumSettings?.()
      ?? ConfigManager.getInstance().getTciSpectrumSettings();
  }

  async setTciSpectrumSettings(settings: TciSpectrumSettings): Promise<TciSpectrumSettings> {
    const applied = await this.tciIqSpectrumController?.setTciSpectrumSettings?.(settings);
    if (applied) return applied;
    // Persist while the optional stream is stopped; the source reads this
    // global configuration when it is created or restarted.
    await ConfigManager.getInstance().updateTciSpectrumSettings(settings);
    return ConfigManager.getInstance().getTciSpectrumSettings();
  }

  getAudioSampleRate(): number {
    return this.currentConfig?.tci?.audioSampleRate ?? DEFAULT_TCI_AUDIO_RATE;
  }

  getTciIqSupport(): TciIqCapabilities {
    if (this.client?.isConnected()) {
      try {
        return this.client.getIqCapabilities();
      } catch {}
    }
    const dialect = this.handshakeResult?.dialect.dialect;
    return {
      supported: Boolean(dialect?.supportsIqStream),
      supportedSampleRates: [...(dialect?.iqSampleRates ?? [])],
    };
  }

  getTciIqIfLimits(): [number, number] | null {
    const limits = this.client?.getState().ifLimits;
    if (!limits || !Number.isFinite(limits[0]) || !Number.isFinite(limits[1]) || limits[1] <= limits[0]) {
      return null;
    }
    return [limits[0], limits[1]];
  }

  async getTciRxFilterBand(): Promise<[number, number] | null> {
    if (!this.client) return null;
    const receiver = this.currentConfig?.tci?.receiver ?? 0;
    const cached = this.client.getState().rxFilterBands[String(receiver)];
    if (cached) return [cached[0], cached[1]];
    if (this.tciRxFilterBandReadPromise) return this.tciRxFilterBandReadPromise;
    this.tciRxFilterBandReadPromise = this.client.getRxFilterBand(receiver)
      .catch(() => undefined)
      .then((band) => band && Number.isFinite(band[0]) && Number.isFinite(band[1]) && band[1] >= band[0]
        ? [band[0], band[1]] as [number, number]
        : null)
      .finally(() => {
        this.tciRxFilterBandReadPromise = null;
      });
    const band = await this.tciRxFilterBandReadPromise;
    if (!band || !Number.isFinite(band[0]) || !Number.isFinite(band[1]) || band[1] < band[0]) return null;
    return [band[0], band[1]];
  }

  getTciIqClientOptions(): TciClientOptions | null {
    const tci = this.currentConfig?.tci;
    const dialect = this.handshakeResult?.dialect.dialect;
    if (!this.connectedUrl || !tci || !dialect?.supportsIqStream || !this.isConnected()) return null;
    return {
      url: this.connectedUrl,
      receiver: tci.receiver ?? 0,
      trx: tci.trx ?? 0,
      vfo: tci.vfo ?? 0,
      connectTimeoutMs: TCI_CONNECT_TIMEOUT_MS,
      handshakeTimeoutMs: 10_000,
      commandTimeoutMs: TCI_COMMAND_TIMEOUT_MS,
      dialect: dialect.id,
    };
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
    this.ensureTxAudioSync().push(samples);
  }

  beginTxAudio(): void {
    this.resetTxAudioSync('superseded-by-new-transmission');
    this.txAudioSync = this.createTxAudioSync();
    this.txAudioSync.begin();
    this.txChronoTraceLogged = false;
    this.txFallbackChronoCount = 0;
    this.txFallbackRequestedSamples = 0;
    this.txFallbackCopiedSamples = 0;
    this.txFallbackMissingSamples = 0;
    const snapshot = this.txAudioSync.snapshot();
    logger.debug(
      `TCI TX audio sync armed sampleRate=${snapshot.sampleRate} channels=${snapshot.channels} sampleType=${snapshot.sampleType} samplesPerFrame=${snapshot.samplesPerFrame} targetLeadMs=${snapshot.targetLeadMs} recommendedPumpIntervalMs=${snapshot.recommendedPumpIntervalMs} queuedSamples=${snapshot.queuedSamples} queuedAudioMs=${snapshot.queuedAudioMs.toFixed(3)}`,
    );
  }

  async waitForTxAudioDrain(timeoutMs: number): Promise<void> {
    const sync = this.txAudioSync;
    if (!sync || sync.snapshot().queuedSamples <= 0) {
      return;
    }
    await sync.drain(timeoutMs);
  }

  endTxAudio(): void {
    this.resetTxAudioSync('tx-end');
  }

  getTxAudioSyncSnapshot(): TciTxAudioSyncSnapshot | null {
    return this.txAudioSync?.snapshot() ?? null;
  }

  private setupClientListeners(client: TciClient): void {
    client.on('disconnected', (reason) => {
      if (this.client !== client) return;
      this.backgroundTasksStarted = false;
      this.resetMeterState();
      this.setState(RadioConnectionState.DISCONNECTED);
      this.emit('disconnected', reason instanceof Error ? reason.message : String(reason ?? 'TCI disconnected'));
    });
    client.on('error', (error) => this.emit('error', this.convertError(error, 'event')));
    client.on('state', () => this.syncStateFromClient());
    client.on('command', (command) => {
      if (TCI_AUDIO_NEGOTIATION_COMMANDS.has(command.name)) {
        logger.debug('TCI audio negotiation command observed', {
          command: command.name,
          args: command.args,
        });
      }
    });
    client.on('rxAudioFrame', (frame) => this.handleRxAudioFrame(frame));
    client.on('txChrono', (request) => {
      if (this.client !== client) return;
      this.handleTxChrono(request);
    });
  }

  private createTxAudioSync(): TciTxAudioSync {
    const audio = this.client?.getState().audio;
    return new TciTxAudioSync({
      sampleRate: audio?.sampleRate ?? this.getAudioSampleRate(),
      sampleType: normalizeSampleType(audio?.sampleType ?? TciSampleType.FLOAT32),
      channels: audio?.channels ?? 1,
      samplesPerFrame: audio?.samplesPerFrame ?? 512,
      targetLeadMs: audio?.txBufferingMs ?? TCI_TX_STREAM_BUFFERING_MS,
      minLeadMs: 120,
      maxLeadMs: 180,
    });
  }

  private ensureTxAudioSync(): TciTxAudioSync {
    if (!this.txAudioSync) {
      this.txAudioSync = this.createTxAudioSync();
      this.txAudioSync.begin();
    }
    return this.txAudioSync;
  }

  private resetTxAudioSync(reason: string): void {
    const sync = this.txAudioSync;
    if (!sync) {
      return;
    }
    this.logTxAudioDiagnostics(reason, sync.snapshot());
    sync.end(reason);
    this.txAudioSync = null;
    this.txChronoTraceLogged = false;
    this.txFallbackChronoCount = 0;
    this.txFallbackRequestedSamples = 0;
    this.txFallbackCopiedSamples = 0;
    this.txFallbackMissingSamples = 0;
  }

  private logTxAudioDiagnostics(reason: string, snapshot: TciTxAudioSyncSnapshot): void {
    const intervalCount = Math.max(0, snapshot.chronoCount - 1);
    const summary = [
      `reason=${reason}`,
      `sampleRate=${snapshot.sampleRate}`,
      `channels=${snapshot.channels}`,
      `sampleType=${snapshot.sampleType}`,
      `samplesPerFrame=${snapshot.samplesPerFrame}`,
      `targetLeadMs=${snapshot.targetLeadMs}`,
      `frameDurationMs=${snapshot.frameDurationMs.toFixed(3)}`,
      `recommendedPumpIntervalMs=${snapshot.recommendedPumpIntervalMs}`,
      `enqueueCount=${snapshot.enqueueCount}`,
      `enqueuedSamples=${snapshot.enqueuedSamples}`,
      `queuedSamples=${snapshot.queuedSamples}`,
      `queuedAudioMs=${snapshot.queuedAudioMs.toFixed(3)}`,
      `chronoCount=${snapshot.chronoCount}`,
      `requestedSamples=${snapshot.requestedSamples}`,
      `copiedSamples=${snapshot.copiedSamples}`,
      `underflowFrames=${snapshot.underflowFrames}`,
      `underflowSamples=${snapshot.underflowSamples}`,
      `fallbackChronoCount=${this.txFallbackChronoCount}`,
      `fallbackRequestedSamples=${this.txFallbackRequestedSamples}`,
      `fallbackCopiedSamples=${this.txFallbackCopiedSamples}`,
      `fallbackMissingSamples=${this.txFallbackMissingSamples}`,
      `maxQueuedSamples=${snapshot.maxQueuedSamples}`,
      `minQueuedSamplesBeforeChrono=${snapshot.minQueuedSamplesBeforeChrono}`,
      `averageChronoIntervalMs=${intervalCount > 0 && snapshot.averageChronoIntervalMs !== null ? snapshot.averageChronoIntervalMs.toFixed(3) : 'null'}`,
      `minChronoIntervalMs=${snapshot.minChronoIntervalMs === null ? 'null' : snapshot.minChronoIntervalMs.toFixed(3)}`,
      `maxChronoIntervalMs=${snapshot.maxChronoIntervalMs.toFixed(3)}`,
    ].join(' ');
    if (reason === 'tx-end' || reason === 'ptt-off' || reason === 'connection-cleanup') {
      logger.info(`TCI TX audio diagnostics summary ${summary}`);
      return;
    }
    logger.debug(`TCI TX audio diagnostics summary ${summary}`);
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
      const nextPtt = state.ptt[trxKey];
      const wasPtt = this.lastKnownPtt;
      this.lastKnownPtt = nextPtt;
      if (wasPtt !== false && !nextPtt) this.clearTxMeterData(true);
    }
    if (typeof state.drive[trxKey] === 'number') {
      this.lastDrivePercent = state.drive[trxKey];
    }

  }

  private async startMeterStream(sessionId: number): Promise<void> {
    const client = this.client;
    const tci = this.currentConfig?.tci;
    if (!client || !tci || sessionId !== this.ioSessionId || !client.isConnected()) return;
    const session = await client.openMeterStream({
      receiver: tci.receiver ?? 0,
      channel: tci.vfo ?? 0,
      trx: tci.trx ?? 0,
      intervalMs: TCI_METER_INTERVAL_MS,
    });
    if (client !== this.client || sessionId !== this.ioSessionId) {
      await session.close().catch(() => undefined);
      return;
    }

    this.meterSession = session;
    this.meterFreshnessMs = Math.max(
      TCI_METER_MIN_FRESHNESS_MS,
      (session.appliedIntervalMs ?? session.requestedIntervalMs) * 4,
    );
    session.on('rxFrame', (frame) => this.handleRxMeterFrame(frame));
    session.on('txFrame', (frame) => this.handleTxMeterFrame(frame));
    session.on('error', (error) => {
      if (error.code === 'protocol-error') this.meterInvalidFrameCount += 1;
    });
    session.on('closed', () => {
      if (this.meterSession !== session) return;
      logger.info('TCI meter stream stopped', {
        invalidFrameCount: this.meterInvalidFrameCount,
        expiryCount: this.meterExpiryCount,
      });
      this.meterSession = null;
    });
    logger.info('TCI meter stream started', {
      requestedIntervalMs: session.requestedIntervalMs,
      appliedIntervalMs: session.appliedIntervalMs,
      receiver: session.receiver,
      channel: session.channel,
      trx: session.trx,
    });
  }

  private handleRxMeterFrame(frame: TciRxMeterFrame): void {
    this.noteMeterInterval('rx', frame.receivedAtMs);
    this.lastRxLevelDbm = frame.levelDbm;
    this.lastRxLevelAtMs = frame.receivedAtMs;
    this.observeMeterCapabilities({ strength: true });
    this.emitMeterData();
    this.scheduleMeterExpiry();
  }

  private handleTxMeterFrame(frame: TciTxMeterFrame): void {
    this.noteMeterInterval('tx', frame.receivedAtMs);
    let changed = false;
    const powerWatts = frame.rmsPowerWatts ?? frame.peakPowerWatts;
    if (powerWatts !== undefined) {
      this.lastTxPowerW = powerWatts;
      this.lastTxPowerAtMs = frame.receivedAtMs;
      this.observeMeterCapabilities({ power: true, powerWatts: true });
      changed = true;
    }
    if (frame.swr !== undefined) {
      this.lastSWR = frame.swr;
      this.lastSwrAtMs = frame.receivedAtMs;
      this.observeMeterCapabilities({ swr: true });
      changed = true;
    }
    if (frame.alc) {
      const raw = frame.alc.value;
      const isDbfs = frame.alc.unit === 'dbfs';
      const percent = isDbfs
        ? clampPercent(((raw + 20) / 20) * 100)
        : clampPercent(raw);
      this.lastAlc = {
        raw,
        percent,
        alert: isDbfs ? raw >= -3 : percent >= 100,
        unit: frame.alc.unit,
      };
      this.lastAlcAtMs = frame.receivedAtMs;
      this.observeMeterCapabilities({ alc: true });
      changed = true;
    }
    if (changed) {
      this.emitMeterData();
      this.scheduleMeterExpiry();
    }
  }

  private observeMeterCapabilities(update: Partial<MeterCapabilities>): void {
    const next = { ...this.meterCapabilities, ...update };
    if (sameMeterCapabilities(next, this.meterCapabilities)) return;
    this.meterCapabilities = next;
    logger.info('TCI meter capabilities observed', next);
    this.emit('meterCapabilitiesChanged', { ...next });
  }

  private noteMeterInterval(kind: 'rx' | 'tx', receivedAtMs: number): void {
    const previous = kind === 'rx' ? this.lastRxMeterFrameAtMs : this.lastTxMeterFrameAtMs;
    const alreadyLogged = kind === 'rx' ? this.rxMeterIntervalLogged : this.txMeterIntervalLogged;
    if (previous > 0 && !alreadyLogged) {
      logger.info('TCI meter interval observed', { kind, intervalMs: receivedAtMs - previous });
      if (kind === 'rx') this.rxMeterIntervalLogged = true;
      else this.txMeterIntervalLogged = true;
    }
    if (kind === 'rx') this.lastRxMeterFrameAtMs = receivedAtMs;
    else this.lastTxMeterFrameAtMs = receivedAtMs;
  }

  private emitMeterData(): void {
    this.emit('meterData', this.buildMeterData());
  }

  private buildMeterData(): MeterData {
    const frequency = this.lastKnownFrequency ?? 14_000_000;
    const s9Dbm = frequency < 30_000_000 ? -73 : -93;
    const dbOffset = (this.lastRxLevelDbm ?? s9Dbm) - s9Dbm;
    const level = this.lastRxLevelDbm === null
      ? null
      : buildLevelMeterReading(this.lastRxLevelDbm, dbOffset, frequency, 's-meter-dbm', formatSValue(dbOffset));
    const powerWatts = this.lastTxPowerW;
    return {
      swr: this.lastSWR === null ? null : { raw: this.lastSWR, swr: this.lastSWR, alert: this.lastSWR >= 2.5 },
      alc: this.lastAlc,
      level,
      power: powerWatts === null || powerWatts === undefined
        ? null
        : { raw: powerWatts, percent: null, watts: powerWatts, maxWatts: null },
    };
  }

  private scheduleMeterExpiry(): void {
    if (this.meterExpiryTimer) clearTimeout(this.meterExpiryTimer);
    const timestamps = [this.lastRxLevelAtMs, this.lastTxPowerAtMs, this.lastSwrAtMs, this.lastAlcAtMs]
      .filter((value) => value > 0);
    if (timestamps.length === 0) {
      this.meterExpiryTimer = null;
      return;
    }
    const nextExpiryAt = Math.min(...timestamps) + this.meterFreshnessMs;
    this.meterExpiryTimer = setTimeout(() => this.expireMeterData(), Math.max(1, nextExpiryAt - Date.now()));
  }

  private expireMeterData(): void {
    this.meterExpiryTimer = null;
    const now = Date.now();
    let changed = false;
    if (this.lastRxLevelAtMs > 0 && now - this.lastRxLevelAtMs >= this.meterFreshnessMs) {
      this.lastRxLevelDbm = null;
      this.lastRxLevelAtMs = 0;
      changed = true;
    }
    if (this.lastTxPowerAtMs > 0 && now - this.lastTxPowerAtMs >= this.meterFreshnessMs) {
      this.lastTxPowerW = null;
      this.lastTxPowerAtMs = 0;
      changed = true;
    }
    if (this.lastSwrAtMs > 0 && now - this.lastSwrAtMs >= this.meterFreshnessMs) {
      this.lastSWR = null;
      this.lastSwrAtMs = 0;
      changed = true;
    }
    if (this.lastAlcAtMs > 0 && now - this.lastAlcAtMs >= this.meterFreshnessMs) {
      this.lastAlc = null;
      this.lastAlcAtMs = 0;
      changed = true;
    }
    if (changed) {
      this.meterExpiryCount += 1;
      this.emitMeterData();
    }
    this.scheduleMeterExpiry();
  }

  private clearTxMeterData(emit: boolean): void {
    const changed = this.lastTxPowerW !== null || this.lastSWR !== null || this.lastAlc !== null;
    this.lastTxPowerW = null;
    this.lastTxPowerAtMs = 0;
    this.lastSWR = null;
    this.lastSwrAtMs = 0;
    this.lastAlc = null;
    this.lastAlcAtMs = 0;
    if (changed && emit) this.emitMeterData();
    this.scheduleMeterExpiry();
  }

  private resetMeterState(): void {
    if (this.meterExpiryTimer) clearTimeout(this.meterExpiryTimer);
    this.meterExpiryTimer = null;
    this.meterSession = null;
    this.meterFreshnessMs = Math.max(TCI_METER_MIN_FRESHNESS_MS, TCI_METER_INTERVAL_MS * 4);
    this.meterCapabilities = createEmptyMeterCapabilities();
    this.meterInvalidFrameCount = 0;
    this.meterExpiryCount = 0;
    this.lastRxMeterFrameAtMs = 0;
    this.lastTxMeterFrameAtMs = 0;
    this.rxMeterIntervalLogged = false;
    this.txMeterIntervalLogged = false;
    this.lastRxLevelDbm = null;
    this.lastRxLevelAtMs = 0;
    this.lastTxPowerW = null;
    this.lastTxPowerAtMs = 0;
    this.lastSWR = null;
    this.lastSwrAtMs = 0;
    this.lastAlc = null;
    this.lastAlcAtMs = 0;
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
      const sync = this.txAudioSync;
      if (!sync) {
        const fallbackSync = this.createTxAudioSync();
        fallbackSync.begin();
        const result = fallbackSync.serviceChrono(request);
        this.txFallbackChronoCount += 1;
        this.txFallbackRequestedSamples += request.sampleCount;
        this.txFallbackCopiedSamples += result.copiedSamples;
        this.txFallbackMissingSamples += result.missingSamples;
        logger.debug(
          `TCI TX chrono served by fallback sync requestedSamples=${request.sampleCount} copiedSamples=${result.copiedSamples} missingSamples=${result.missingSamples}`,
        );
        this.client?.sendTxAudioForChrono(request, result.samples);
        return;
      }
      const result = sync.serviceChrono(request);
      if (!this.txChronoTraceLogged) {
        this.txChronoTraceLogged = true;
        const snapshot = sync.snapshot();
        logger.debug(
          `TCI TX chrono path active requestedSamples=${request.sampleCount} copiedSamples=${result.copiedSamples} missingSamples=${result.missingSamples} queuedSamples=${snapshot.queuedSamples} queuedAudioMs=${snapshot.queuedAudioMs.toFixed(3)} samplesPerFrame=${snapshot.samplesPerFrame} targetLeadMs=${snapshot.targetLeadMs} recommendedPumpIntervalMs=${snapshot.recommendedPumpIntervalMs}`,
        );
      }
      this.client?.sendTxAudioForChrono(request, result.samples);
    } catch (error) {
      this.emit('error', this.convertError(error, 'txChrono'));
    }
  }

  private async cleanup(): Promise<void> {
    const client = this.client;
    const meterSession = this.meterSession;
    this.client = null;
    this.backgroundTasksStarted = false;
    this.audioRunning = false;
    this.audioStreamOwners.clear();
    this.resetTxAudioSync('connection-cleanup');
    await meterSession?.close().catch((error) => logger.debug('TCI meter stream cleanup failed', error));
    if (client) {
      client.removeAllListeners();
      await client.disconnect().catch((error) => logger.debug('TCI disconnect cleanup failed', error));
    }
    this.resetMeterState();
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
      context: {
        operation,
        protocol: 'tci',
        writeTimeout: isWriteTimeout,
        recoverable: isWriteTimeout,
        stateUncertain: operation === 'setPTT' && this.pttWriteUncertain,
      },
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

export function resolveTciEndpointCandidates(tci: NonNullable<RadioConnectionConfig['tci']>): string[] {
  if (tci.url) return [new URL(tci.url).toString()];
  const configuredPort = tci.port || DEFAULT_TCI_PORT;
  const ports = tci.autoDiscoverPorts !== false && configuredPort === DEFAULT_TCI_PORT
    ? [DEFAULT_TCI_PORT, 50_001]
    : [configuredPort];
  return ports.map((port) => {
    const host = tci.host.includes(':') && !tci.host.startsWith('[') ? `[${tci.host}]` : tci.host;
    return new URL(`ws://${host}:${port}/`).toString();
  });
}

function createEmptyMeterCapabilities(): MeterCapabilities {
  return { strength: false, swr: false, alc: false, power: false, powerWatts: false };
}

function sameMeterCapabilities(left: MeterCapabilities, right: MeterCapabilities): boolean {
  return left.strength === right.strength
    && left.swr === right.swr
    && left.alc === right.alc
    && left.power === right.power
    && left.powerWatts === right.powerWatts;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
