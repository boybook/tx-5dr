import { EventEmitter } from 'eventemitter3';
import type { MeterCapabilities, TxAudioInputSource } from '@tx5dr/contracts';
import type { ManagedSpectrumConfig, SpectrumLine } from 'hamlib/spectrum';
import type { ApplyOperatingStateRequest, IRadioConnection, IRadioConnectionEvents, RadioConnectionConfig, RadioConnectOptions, RadioModeBandwidth, RadioSpectrumRuntimeConfig, SetRadioModeOptions } from './IRadioConnection.js';
import { RadioConnectionState, RadioConnectionType } from './IRadioConnection.js';
import type { HamlibRuntime } from './hamlib/HamlibRuntime.js';
import { HamlibTransport, LocalHamlibTransport } from './hamlib/HamlibTransport.js';
import { ProcessHamlibTransport } from './hamlib/ProcessHamlibTransport.js';
import { deserializeHamlibError, type HamlibOperation, type HamlibSnapshot } from './hamlib/hamlib-protocol.js';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('HamlibConnection');
export type HamlibExecutionMode = 'process' | 'in-process';

export function createHamlibTransport(mode: HamlibExecutionMode): HamlibTransport {
  return mode === 'in-process' ? new LocalHamlibTransport() : new ProcessHamlibTransport();
}

function emptySnapshot(): HamlibSnapshot {
  return { state: 'disconnected', healthy: false, lastSuccessfulOperation: 0, levels: [], functions: [], parms: [], vfoOps: [], activities: [],
    meterCapabilities: { strength: false, swr: false, alc: false, power: false, powerWatts: false },
    queue: { busy: false, backpressure: false, criticalActive: false, activeCount: 0, activeTask: null, activeRunMs: null, pendingCount: 0, criticalPendingCount: 0, normalPendingCount: 0, oldestPendingTask: null, oldestPendingWaitMs: null, dedupedTaskCount: 0 } };
}

export class HamlibConnection extends EventEmitter<IRadioConnectionEvents> implements IRadioConnection {
  private transport: HamlibTransport | null = null;
  private snapshot = emptySnapshot();
  private config: RadioConnectionConfig | null = null;
  private spectrumListener: ((line: SpectrumLine) => void) | null = null;
  private failure: Error | null = null;
  private observedAt = Date.now();
  private disconnecting = false;

  constructor(private readonly preferredMode?: HamlibExecutionMode) { super(); }

  async connect(config: RadioConnectionConfig, options?: RadioConnectOptions): Promise<void> {
    if (this.getState() === RadioConnectionState.CONNECTING) throw RadioError.invalidState('connect', this.getState(), RadioConnectionState.DISCONNECTED);
    await this.transport?.close();
    this.config = config;
    this.failure = null;
    this.snapshot = emptySnapshot();
    const transport = createHamlibTransport(this.preferredMode ?? config.hamlibExecutionMode ?? 'process');
    this.transport = transport;
    transport.on('snapshot', snapshot => {
      if (this.transport !== transport || this.failure || this.disconnecting) return;
      this.snapshot = snapshot;
      this.observedAt = Date.now();
    });
    transport.on('event', payload => {
      if (this.transport !== transport || this.failure || this.disconnecting) return;
      if (payload.event === 'spectrumLine') this.spectrumListener?.(payload.args[0]);
      else if (payload.event === 'error') this.emit('error', deserializeHamlibError(payload.args[0]));
      else if (payload.event === 'stateChanged') this.emit('stateChanged', payload.args[0] as RadioConnectionState);
      else if (payload.event === 'connected') this.emit('connected');
      else if (payload.event === 'disconnected') this.emit('disconnected', payload.args[0]);
      else if (payload.event === 'frequencyChanged') this.emit('frequencyChanged', payload.args[0]);
      else if (payload.event === 'meterData') this.emit('meterData', payload.args[0]);
      else if (payload.event === 'meterCapabilitiesChanged') this.emit('meterCapabilitiesChanged', payload.args[0]);
    });
    transport.on('fault', error => this.reportFault(error));
    try { await transport.call('connect', [config, options]); }
    catch (error) { await transport.close(); this.snapshot.state = 'disconnected'; throw error; }
  }

  private reportFault(error: Error): void {
    if (this.failure) return;
    const radioError = RadioError.from(error);
    this.failure = new RadioError({ code: radioError.code, message: radioError.message, userMessage: radioError.userMessage,
      userMessageKey: radioError.userMessageKey, userMessageParams: radioError.userMessageParams, severity: radioError.severity,
      suggestions: radioError.suggestions, cause: error, context: { ...radioError.context, ...this.transport?.diagnostics,
        hamlibHostFatal: true, restartRequired: this.transport?.mode === 'in-process' } });
    this.snapshot.state = 'error';
    this.snapshot.healthy = false;
    this.spectrumListener = null;
    logger.error('Hamlib host failed', { ...this.transport?.diagnostics, error: error.message });
    this.emit('stateChanged', RadioConnectionState.ERROR);
    if (!this.disconnecting) this.emit('error', this.failure);
  }

  private async invoke(operation: HamlibOperation, args: unknown[] = []): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (!this.transport) throw new RadioError({ code: RadioErrorCode.NOT_INITIALIZED, message: 'Hamlib connection is not initialized' });
    return this.transport.call(operation, args);
  }

  async disconnect(reason?: string): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    this.disconnecting = true;
    this.spectrumListener = null;
    try { await transport.close(); }
    finally { this.disconnecting = false; }
    if (this.transport !== transport) return;
    this.transport = null;
    this.snapshot = emptySnapshot();
    this.emit('stateChanged', RadioConnectionState.DISCONNECTED);
    this.emit('disconnected', reason);
  }

  getType(): RadioConnectionType { return RadioConnectionType.HAMLIB; }
  getState(): RadioConnectionState { return this.snapshot.state as RadioConnectionState; }
  isHealthy(): boolean { return !this.failure && this.snapshot.healthy && Date.now() - this.observedAt < 5000; }
  isCriticalOperationActive(): boolean { return Boolean(this.failure) || this.snapshot.queue.criticalActive; }
  getRadioIoQueueSnapshot() { return { ...this.snapshot.queue, activeRunMs: this.snapshot.queue.activeRunMs === null ? null : this.snapshot.queue.activeRunMs + Date.now() - this.observedAt }; }
  getConnectionInfo() { return { type: this.getType(), state: this.getState(), config: this.config ?? {}, diagnostics: this.transport?.diagnostics }; }
  getMeterCapabilities(): MeterCapabilities { return { ...this.snapshot.meterCapabilities }; }
  supportsCWMessageKeyer(): boolean { return this.isSupportedFunction('SEND_MORSE'); }
  isSupportedLevel(level: string): boolean { return this.snapshot.levels.includes(level); }
  isSupportedFunction(name: string): boolean { return this.snapshot.functions.includes(name.trim().toUpperCase()); }
  isSupportedParm(name: string): boolean { return this.snapshot.parms.includes(name.trim().toUpperCase()); }
  isSupportedVfoOp(name: string): boolean { return this.snapshot.vfoOps.includes(name.trim().toUpperCase()); }
  startBackgroundTasks(): void { void this.invoke('startBackgroundTasks').catch(error => this.reportFault(error)); }
  setKnownFrequency(frequencyHz: number): void { void this.invoke('setKnownFrequency', [frequencyHz]).catch(error => logger.debug('Known frequency update rejected', { error: String(error) })); }
  async startManagedSpectrum(listener: (line: SpectrumLine) => void, config?: ManagedSpectrumConfig): Promise<void> {
    this.spectrumListener = listener;
    try { await this.invoke('startManagedSpectrum', [config]); }
    catch (error) { this.spectrumListener = null; throw error; }
  }
  async stopManagedSpectrum(): Promise<void> { this.spectrumListener = null; await this.invoke('stopManagedSpectrum'); }
  promoteToFull(): ReturnType<HamlibRuntime['promoteToFull']> { return this.invoke('promoteToFull', []) as ReturnType<HamlibRuntime['promoteToFull']>; }
  probeResponding(timeoutMs = 3000): ReturnType<HamlibRuntime['probeResponding']> { return this.invoke('probeResponding', [timeoutMs]) as ReturnType<HamlibRuntime['probeResponding']>; }
  setFrequency(frequency: number): ReturnType<HamlibRuntime['setFrequency']> { return this.invoke('setFrequency', [frequency]) as ReturnType<HamlibRuntime['setFrequency']>; }
  getFrequency(): ReturnType<HamlibRuntime['getFrequency']> { return this.invoke('getFrequency', []) as ReturnType<HamlibRuntime['getFrequency']>; }
  setPTT(enabled: boolean): ReturnType<HamlibRuntime['setPTT']> { return this.invoke('setPTT', [enabled]) as ReturnType<HamlibRuntime['setPTT']>; }
  sendCWMessage(message: string, wpm: number): ReturnType<HamlibRuntime['sendCWMessage']> { return this.invoke('sendCWMessage', [message, wpm]) as ReturnType<HamlibRuntime['sendCWMessage']>; }
  waitCWMessage(): ReturnType<HamlibRuntime['waitCWMessage']> { return this.invoke('waitCWMessage', []) as ReturnType<HamlibRuntime['waitCWMessage']>; }
  stopCWMessage(): ReturnType<HamlibRuntime['stopCWMessage']> { return this.invoke('stopCWMessage', []) as ReturnType<HamlibRuntime['stopCWMessage']>; }
  getPTT(): ReturnType<HamlibRuntime['getPTT']> { return this.invoke('getPTT', []) as ReturnType<HamlibRuntime['getPTT']>; }
  setMode(mode: string, bandwidth?: RadioModeBandwidth, options?: SetRadioModeOptions): ReturnType<HamlibRuntime['setMode']> { return this.invoke('setMode', [mode, bandwidth, options]) as ReturnType<HamlibRuntime['setMode']>; }
  applyOperatingState(request: ApplyOperatingStateRequest): ReturnType<HamlibRuntime['applyOperatingState']> { return this.invoke('applyOperatingState', [request]) as ReturnType<HamlibRuntime['applyOperatingState']>; }
  getMode(): ReturnType<HamlibRuntime['getMode']> { return this.invoke('getMode', []) as ReturnType<HamlibRuntime['getMode']>; }
  getModeBandwidth(): ReturnType<HamlibRuntime['getModeBandwidth']> { return this.invoke('getModeBandwidth', []) as ReturnType<HamlibRuntime['getModeBandwidth']>; }
  setModeBandwidth(bandwidth: RadioModeBandwidth): ReturnType<HamlibRuntime['setModeBandwidth']> { return this.invoke('setModeBandwidth', [bandwidth]) as ReturnType<HamlibRuntime['setModeBandwidth']>; }
  getSupportedModeBandwidths(): ReturnType<HamlibRuntime['getSupportedModeBandwidths']> { return this.invoke('getSupportedModeBandwidths', []) as ReturnType<HamlibRuntime['getSupportedModeBandwidths']>; }
  getSupportedModes(): ReturnType<HamlibRuntime['getSupportedModes']> { return this.invoke('getSupportedModes', []) as ReturnType<HamlibRuntime['getSupportedModes']>; }
  getSpectrumSupportSummary(): ReturnType<HamlibRuntime['getSpectrumSupportSummary']> { return this.invoke('getSpectrumSupportSummary', []) as ReturnType<HamlibRuntime['getSpectrumSupportSummary']>; }
  getSpectrumSpans(): ReturnType<HamlibRuntime['getSpectrumSpans']> { return this.invoke('getSpectrumSpans', []) as ReturnType<HamlibRuntime['getSpectrumSpans']>; }
  getCurrentSpectrumSpan(): ReturnType<HamlibRuntime['getCurrentSpectrumSpan']> { return this.invoke('getCurrentSpectrumSpan', []) as ReturnType<HamlibRuntime['getCurrentSpectrumSpan']>; }
  setSpectrumSpan(spanHz: number): ReturnType<HamlibRuntime['setSpectrumSpan']> { return this.invoke('setSpectrumSpan', [spanHz]) as ReturnType<HamlibRuntime['setSpectrumSpan']>; }
  getSpectrumDisplayState(): ReturnType<HamlibRuntime['getSpectrumDisplayState']> { return this.invoke('getSpectrumDisplayState', []) as ReturnType<HamlibRuntime['getSpectrumDisplayState']>; }
  configureSpectrumDisplay(config: { mode?: 'center' | 'fixed' | 'scroll-center' | 'scroll-fixed'; spanHz?: number; edgeSlot?: number; edgeLowHz?: number; edgeHighHz?: number; }): ReturnType<HamlibRuntime['configureSpectrumDisplay']> { return this.invoke('configureSpectrumDisplay', [config]) as ReturnType<HamlibRuntime['configureSpectrumDisplay']>; }
  applySpectrumRuntimeConfig(config: RadioSpectrumRuntimeConfig): ReturnType<HamlibRuntime['applySpectrumRuntimeConfig']> { return this.invoke('applySpectrumRuntimeConfig', [config]) as ReturnType<HamlibRuntime['applySpectrumRuntimeConfig']>; }
  getTunerCapabilities(): ReturnType<HamlibRuntime['getTunerCapabilities']> { return this.invoke('getTunerCapabilities', []) as ReturnType<HamlibRuntime['getTunerCapabilities']>; }
  setTuner(enabled: boolean): ReturnType<HamlibRuntime['setTuner']> { return this.invoke('setTuner', [enabled]) as ReturnType<HamlibRuntime['setTuner']>; }
  getTunerStatus(): ReturnType<HamlibRuntime['getTunerStatus']> { return this.invoke('getTunerStatus', []) as ReturnType<HamlibRuntime['getTunerStatus']>; }
  startTuning(): ReturnType<HamlibRuntime['startTuning']> { return this.invoke('startTuning', []) as ReturnType<HamlibRuntime['startTuning']>; }
  getRFPower(): ReturnType<HamlibRuntime['getRFPower']> { return this.invoke('getRFPower', []) as ReturnType<HamlibRuntime['getRFPower']>; }
  setRFPower(value: number): ReturnType<HamlibRuntime['setRFPower']> { return this.invoke('setRFPower', [value]) as ReturnType<HamlibRuntime['setRFPower']>; }
  getSupportedRFPowerSteps(): ReturnType<HamlibRuntime['getSupportedRFPowerSteps']> { return this.invoke('getSupportedRFPowerSteps', []) as ReturnType<HamlibRuntime['getSupportedRFPowerSteps']>; }
  getAFGain(): ReturnType<HamlibRuntime['getAFGain']> { return this.invoke('getAFGain', []) as ReturnType<HamlibRuntime['getAFGain']>; }
  setAFGain(value: number): ReturnType<HamlibRuntime['setAFGain']> { return this.invoke('setAFGain', [value]) as ReturnType<HamlibRuntime['setAFGain']>; }
  getSQL(): ReturnType<HamlibRuntime['getSQL']> { return this.invoke('getSQL', []) as ReturnType<HamlibRuntime['getSQL']>; }
  setSQL(value: number): ReturnType<HamlibRuntime['setSQL']> { return this.invoke('setSQL', [value]) as ReturnType<HamlibRuntime['setSQL']>; }
  getDCD(): ReturnType<HamlibRuntime['getDCD']> { return this.invoke('getDCD', []) as ReturnType<HamlibRuntime['getDCD']>; }
  getMicGain(): ReturnType<HamlibRuntime['getMicGain']> { return this.invoke('getMicGain', []) as ReturnType<HamlibRuntime['getMicGain']>; }
  setMicGain(value: number): ReturnType<HamlibRuntime['setMicGain']> { return this.invoke('setMicGain', [value]) as ReturnType<HamlibRuntime['setMicGain']>; }
  getCompressorEnabled(): ReturnType<HamlibRuntime['getCompressorEnabled']> { return this.invoke('getCompressorEnabled', []) as ReturnType<HamlibRuntime['getCompressorEnabled']>; }
  setCompressorEnabled(enabled: boolean): ReturnType<HamlibRuntime['setCompressorEnabled']> { return this.invoke('setCompressorEnabled', [enabled]) as ReturnType<HamlibRuntime['setCompressorEnabled']>; }
  getCompressorLevel(): ReturnType<HamlibRuntime['getCompressorLevel']> { return this.invoke('getCompressorLevel', []) as ReturnType<HamlibRuntime['getCompressorLevel']>; }
  setCompressorLevel(value: number): ReturnType<HamlibRuntime['setCompressorLevel']> { return this.invoke('setCompressorLevel', [value]) as ReturnType<HamlibRuntime['setCompressorLevel']>; }
  getMonitorGain(): ReturnType<HamlibRuntime['getMonitorGain']> { return this.invoke('getMonitorGain', []) as ReturnType<HamlibRuntime['getMonitorGain']>; }
  setMonitorGain(value: number): ReturnType<HamlibRuntime['setMonitorGain']> { return this.invoke('setMonitorGain', [value]) as ReturnType<HamlibRuntime['setMonitorGain']>; }
  getNBEnabled(): ReturnType<HamlibRuntime['getNBEnabled']> { return this.invoke('getNBEnabled', []) as ReturnType<HamlibRuntime['getNBEnabled']>; }
  setNBEnabled(enabled: boolean): ReturnType<HamlibRuntime['setNBEnabled']> { return this.invoke('setNBEnabled', [enabled]) as ReturnType<HamlibRuntime['setNBEnabled']>; }
  getNBLevel(): ReturnType<HamlibRuntime['getNBLevel']> { return this.invoke('getNBLevel', []) as ReturnType<HamlibRuntime['getNBLevel']>; }
  setNBLevel(value: number): ReturnType<HamlibRuntime['setNBLevel']> { return this.invoke('setNBLevel', [value]) as ReturnType<HamlibRuntime['setNBLevel']>; }
  getNREnabled(): ReturnType<HamlibRuntime['getNREnabled']> { return this.invoke('getNREnabled', []) as ReturnType<HamlibRuntime['getNREnabled']>; }
  setNREnabled(enabled: boolean): ReturnType<HamlibRuntime['setNREnabled']> { return this.invoke('setNREnabled', [enabled]) as ReturnType<HamlibRuntime['setNREnabled']>; }
  getNRLevel(): ReturnType<HamlibRuntime['getNRLevel']> { return this.invoke('getNRLevel', []) as ReturnType<HamlibRuntime['getNRLevel']>; }
  setNRLevel(value: number): ReturnType<HamlibRuntime['setNRLevel']> { return this.invoke('setNRLevel', [value]) as ReturnType<HamlibRuntime['setNRLevel']>; }
  getLockMode(): ReturnType<HamlibRuntime['getLockMode']> { return this.invoke('getLockMode', []) as ReturnType<HamlibRuntime['getLockMode']>; }
  setLockMode(enabled: boolean): ReturnType<HamlibRuntime['setLockMode']> { return this.invoke('setLockMode', [enabled]) as ReturnType<HamlibRuntime['setLockMode']>; }
  getMuteEnabled(): ReturnType<HamlibRuntime['getMuteEnabled']> { return this.invoke('getMuteEnabled', []) as ReturnType<HamlibRuntime['getMuteEnabled']>; }
  setMuteEnabled(enabled: boolean): ReturnType<HamlibRuntime['setMuteEnabled']> { return this.invoke('setMuteEnabled', [enabled]) as ReturnType<HamlibRuntime['setMuteEnabled']>; }
  getVOXEnabled(): ReturnType<HamlibRuntime['getVOXEnabled']> { return this.invoke('getVOXEnabled', []) as ReturnType<HamlibRuntime['getVOXEnabled']>; }
  setVOXEnabled(enabled: boolean): ReturnType<HamlibRuntime['setVOXEnabled']> { return this.invoke('setVOXEnabled', [enabled]) as ReturnType<HamlibRuntime['setVOXEnabled']>; }
  getAgcMode(): ReturnType<HamlibRuntime['getAgcMode']> { return this.invoke('getAgcMode', []) as ReturnType<HamlibRuntime['getAgcMode']>; }
  setAgcMode(mode: string): ReturnType<HamlibRuntime['setAgcMode']> { return this.invoke('setAgcMode', [mode]) as ReturnType<HamlibRuntime['setAgcMode']>; }
  getSupportedAgcModes(): ReturnType<HamlibRuntime['getSupportedAgcModes']> { return this.invoke('getSupportedAgcModes', []) as ReturnType<HamlibRuntime['getSupportedAgcModes']>; }
  getPreampLevel(): ReturnType<HamlibRuntime['getPreampLevel']> { return this.invoke('getPreampLevel', []) as ReturnType<HamlibRuntime['getPreampLevel']>; }
  setPreampLevel(value: number): ReturnType<HamlibRuntime['setPreampLevel']> { return this.invoke('setPreampLevel', [value]) as ReturnType<HamlibRuntime['setPreampLevel']>; }
  getSupportedPreampLevels(): ReturnType<HamlibRuntime['getSupportedPreampLevels']> { return this.invoke('getSupportedPreampLevels', []) as ReturnType<HamlibRuntime['getSupportedPreampLevels']>; }
  getAttenuatorLevel(): ReturnType<HamlibRuntime['getAttenuatorLevel']> { return this.invoke('getAttenuatorLevel', []) as ReturnType<HamlibRuntime['getAttenuatorLevel']>; }
  setAttenuatorLevel(value: number): ReturnType<HamlibRuntime['setAttenuatorLevel']> { return this.invoke('setAttenuatorLevel', [value]) as ReturnType<HamlibRuntime['setAttenuatorLevel']>; }
  getSupportedAttenuatorLevels(): ReturnType<HamlibRuntime['getSupportedAttenuatorLevels']> { return this.invoke('getSupportedAttenuatorLevels', []) as ReturnType<HamlibRuntime['getSupportedAttenuatorLevels']>; }
  getRitOffset(): ReturnType<HamlibRuntime['getRitOffset']> { return this.invoke('getRitOffset', []) as ReturnType<HamlibRuntime['getRitOffset']>; }
  setRitOffset(offsetHz: number): ReturnType<HamlibRuntime['setRitOffset']> { return this.invoke('setRitOffset', [offsetHz]) as ReturnType<HamlibRuntime['setRitOffset']>; }
  getXitOffset(): ReturnType<HamlibRuntime['getXitOffset']> { return this.invoke('getXitOffset', []) as ReturnType<HamlibRuntime['getXitOffset']>; }
  setXitOffset(offsetHz: number): ReturnType<HamlibRuntime['setXitOffset']> { return this.invoke('setXitOffset', [offsetHz]) as ReturnType<HamlibRuntime['setXitOffset']>; }
  getTuningStep(): ReturnType<HamlibRuntime['getTuningStep']> { return this.invoke('getTuningStep', []) as ReturnType<HamlibRuntime['getTuningStep']>; }
  setTuningStep(stepHz: number): ReturnType<HamlibRuntime['setTuningStep']> { return this.invoke('setTuningStep', [stepHz]) as ReturnType<HamlibRuntime['setTuningStep']>; }
  getSupportedTuningSteps(): ReturnType<HamlibRuntime['getSupportedTuningSteps']> { return this.invoke('getSupportedTuningSteps', []) as ReturnType<HamlibRuntime['getSupportedTuningSteps']>; }
  getPowerState(): ReturnType<HamlibRuntime['getPowerState']> { return this.invoke('getPowerState', []) as ReturnType<HamlibRuntime['getPowerState']>; }
  setPowerState(state: string): ReturnType<HamlibRuntime['setPowerState']> { return this.invoke('setPowerState', [state]) as ReturnType<HamlibRuntime['setPowerState']>; }
  getRepeaterShift(): ReturnType<HamlibRuntime['getRepeaterShift']> { return this.invoke('getRepeaterShift', []) as ReturnType<HamlibRuntime['getRepeaterShift']>; }
  setRepeaterShift(shift: string): ReturnType<HamlibRuntime['setRepeaterShift']> { return this.invoke('setRepeaterShift', [shift]) as ReturnType<HamlibRuntime['setRepeaterShift']>; }
  getRepeaterOffset(): ReturnType<HamlibRuntime['getRepeaterOffset']> { return this.invoke('getRepeaterOffset', []) as ReturnType<HamlibRuntime['getRepeaterOffset']>; }
  setRepeaterOffset(offsetHz: number): ReturnType<HamlibRuntime['setRepeaterOffset']> { return this.invoke('setRepeaterOffset', [offsetHz]) as ReturnType<HamlibRuntime['setRepeaterOffset']>; }
  getTxAudioInputSource(): ReturnType<HamlibRuntime['getTxAudioInputSource']> { return this.invoke('getTxAudioInputSource', []) as ReturnType<HamlibRuntime['getTxAudioInputSource']>; }
  getSupportedTxAudioInputSources(): ReturnType<HamlibRuntime['getSupportedTxAudioInputSources']> { return this.invoke('getSupportedTxAudioInputSources', []) as ReturnType<HamlibRuntime['getSupportedTxAudioInputSources']>; }
  setTxAudioInputSource(source: TxAudioInputSource): ReturnType<HamlibRuntime['setTxAudioInputSource']> { return this.invoke('setTxAudioInputSource', [source]) as ReturnType<HamlibRuntime['setTxAudioInputSource']>; }
  getCtcssTone(): ReturnType<HamlibRuntime['getCtcssTone']> { return this.invoke('getCtcssTone', []) as ReturnType<HamlibRuntime['getCtcssTone']>; }
  setCtcssTone(tone: number): ReturnType<HamlibRuntime['setCtcssTone']> { return this.invoke('setCtcssTone', [tone]) as ReturnType<HamlibRuntime['setCtcssTone']>; }
  getAvailableCtcssTones(): ReturnType<HamlibRuntime['getAvailableCtcssTones']> { return this.invoke('getAvailableCtcssTones', []) as ReturnType<HamlibRuntime['getAvailableCtcssTones']>; }
  getDcsCode(): ReturnType<HamlibRuntime['getDcsCode']> { return this.invoke('getDcsCode', []) as ReturnType<HamlibRuntime['getDcsCode']>; }
  setDcsCode(code: number): ReturnType<HamlibRuntime['setDcsCode']> { return this.invoke('setDcsCode', [code]) as ReturnType<HamlibRuntime['setDcsCode']>; }
  getAvailableDcsCodes(): ReturnType<HamlibRuntime['getAvailableDcsCodes']> { return this.invoke('getAvailableDcsCodes', []) as ReturnType<HamlibRuntime['getAvailableDcsCodes']>; }
  getMaxRit(): ReturnType<HamlibRuntime['getMaxRit']> { return this.invoke('getMaxRit', []) as ReturnType<HamlibRuntime['getMaxRit']>; }
  getMaxXit(): ReturnType<HamlibRuntime['getMaxXit']> { return this.invoke('getMaxXit', []) as ReturnType<HamlibRuntime['getMaxXit']>; }
  getSplitEnabled(): ReturnType<HamlibRuntime['getSplitEnabled']> { return this.invoke('getSplitEnabled', []) as ReturnType<HamlibRuntime['getSplitEnabled']>; }
  setSplitEnabled(enabled: boolean): ReturnType<HamlibRuntime['setSplitEnabled']> { return this.invoke('setSplitEnabled', [enabled]) as ReturnType<HamlibRuntime['setSplitEnabled']>; }
  getSplitFrequency(): ReturnType<HamlibRuntime['getSplitFrequency']> { return this.invoke('getSplitFrequency', []) as ReturnType<HamlibRuntime['getSplitFrequency']>; }
  setSplitFrequency(txFrequency: number): ReturnType<HamlibRuntime['setSplitFrequency']> { return this.invoke('setSplitFrequency', [txFrequency]) as ReturnType<HamlibRuntime['setSplitFrequency']>; }
  setSplitFreqMode(txFrequency: number, txMode: string, txWidth: number): ReturnType<HamlibRuntime['setSplitFreqMode']> { return this.invoke('setSplitFreqMode', [txFrequency, txMode, txWidth]) as ReturnType<HamlibRuntime['setSplitFreqMode']>; }
}
