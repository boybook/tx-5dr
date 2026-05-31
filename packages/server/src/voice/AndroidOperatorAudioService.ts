import { EventEmitter } from 'eventemitter3';
import type { AndroidOperatorAudioStatus, VoicePTTLock } from '@tx5dr/contracts';
import { AndroidAudioInputSocket, AndroidAudioOutputSocket } from '../audio/AndroidAudioSocketBackend.js';
import {
  getAndroidAudioDevices,
  isAndroidBridgeRuntime,
  type AndroidAudioDeviceDescriptor,
} from '../audio/android-audio-devices.js';
import type { RealtimeRxAudioRouter } from '../realtime/RealtimeRxAudioRouter.js';
import type { RealtimeAudioFrame, RealtimeRxAudioSource } from '../realtime/RealtimeRxAudioSource.js';
import { FixedFrameAudioBuffer, StreamingLinearResampler } from '../realtime/StreamingAudioResampler.js';
import { createLogger } from '../utils/logger.js';
import type { VoiceSessionManager } from './VoiceSessionManager.js';
import type { VoiceTxFrameMeta } from './VoiceTxDiagnostics.js';

const logger = createLogger('AndroidOperatorAudioService');
const PARTICIPANT_IDENTITY = 'android-native:operator';
const FRAME_DURATION_MS = 20;
const STATUS_LEVEL_EMIT_INTERVAL_MS = 100;
const INPUT_SILENCE_HOLD_MS = 1500;
const DEFAULT_MIC_GAIN_DB = 18;
const MAX_MIC_GAIN_DB = 24;
const MIN_MIC_GAIN_DB = -12;
const BUILTIN_MIC_KINDS = new Set(['builtinMic', 'builtin-mic', 'builtin_microphone', 'builtinMicrophone']);
const BUILTIN_SPEAKER_KINDS = new Set(['builtinSpeaker', 'builtin-speaker']);

type CaptureState = AndroidOperatorAudioStatus['captureState'];
type MonitorState = AndroidOperatorAudioStatus['monitorState'];

type InputSocketFactory = (device: AndroidAudioDeviceDescriptor) => AndroidAudioInputSocket;
type OutputSocketFactory = (
  device: AndroidAudioDeviceDescriptor,
  config: { sampleRate: number; format: 'f32le'; channels: 1 },
) => AndroidAudioOutputSocket;

export interface AndroidOperatorAudioServiceEvents {
  statusChanged: (status: AndroidOperatorAudioStatus) => void;
}

export interface AndroidOperatorAudioServiceDeps {
  voiceSessionManager: VoiceSessionManager;
  rxAudioRouter: RealtimeRxAudioRouter;
  inputSocketFactory?: InputSocketFactory;
  outputSocketFactory?: OutputSocketFactory;
}

export class AndroidOperatorAudioService extends EventEmitter<AndroidOperatorAudioServiceEvents> {
  private readonly inputSocketFactory: InputSocketFactory;
  private readonly outputSocketFactory: OutputSocketFactory;
  private captureSocket: AndroidAudioInputSocket | null = null;
  private outputSocket: AndroidAudioOutputSocket | null = null;
  private monitorSource: RealtimeRxAudioSource | null = null;
  private captureFrameBuffer: FixedFrameAudioBuffer | null = null;
  private captureFrameSampleRate = 0;
  private monitorResampler: StreamingLinearResampler | null = null;
  private monitorResamplerKey = '';
  private captureState: CaptureState = 'idle';
  private monitorState: MonitorState = 'idle';
  private monitorRequested = false;
  private inputLevel = 0;
  private inputPeak = 0;
  private rawInputLevel = 0;
  private rawInputPeak = 0;
  private lastInputAtMs = 0;
  private lastNonSilentInputAtMs = 0;
  private lastError: string | null = null;
  private sequence = 0;
  private lastStatusEmitAt = 0;
  private preparePromise: Promise<AndroidOperatorAudioStatus> | null = null;
  private monitorStartPromise: Promise<AndroidOperatorAudioStatus> | null = null;
  private micGainDb = getMicGainDb();
  private micGain = dbToGain(this.micGainDb);

  constructor(private readonly deps: AndroidOperatorAudioServiceDeps) {
    super();
    this.inputSocketFactory = deps.inputSocketFactory ?? ((device) => new AndroidAudioInputSocket(device));
    this.outputSocketFactory = deps.outputSocketFactory ?? ((device, config) => new AndroidAudioOutputSocket(device, config));
    this.deps.voiceSessionManager.on('voicePttLockChanged', this.handlePttLockChanged);
  }

  getStatus(): AndroidOperatorAudioStatus {
    const devices = this.resolveDevices();
    return {
      available: Boolean(devices.mic && devices.speaker && isAndroidBridgeRuntime()),
      captureState: this.captureState,
      monitorState: this.effectiveMonitorState(),
      participantIdentity: devices.mic && devices.speaker ? PARTICIPANT_IDENTITY : null,
      inputLevel: clamp01(this.inputLevel),
      inputPeak: clamp01(this.inputPeak),
      rawInputLevel: clamp01(this.rawInputLevel),
      rawInputPeak: clamp01(this.rawInputPeak),
      inputSilenced: this.isInputSilenced(),
      micGainDb: this.micGainDb,
      micGainMinDb: MIN_MIC_GAIN_DB,
      micGainMaxDb: MAX_MIC_GAIN_DB,
      micDevice: devices.mic ? toStatusDevice(devices.mic) : null,
      speakerDevice: devices.speaker ? toStatusDevice(devices.speaker) : null,
      lastError: this.lastError,
    };
  }

  async prepare(): Promise<AndroidOperatorAudioStatus> {
    if (this.captureState === 'capturing') {
      return this.getStatus();
    }
    if (this.preparePromise) {
      return this.preparePromise;
    }

    this.preparePromise = this.prepareInternal().finally(() => {
      this.preparePromise = null;
    });
    return this.preparePromise;
  }

  setMicGainDb(value: number): AndroidOperatorAudioStatus {
    const nextGainDb = clampMicGainDb(value);
    this.micGainDb = nextGainDb;
    this.micGain = dbToGain(nextGainDb);
    logger.info('Android native operator microphone gain updated', {
      micGainDb: this.micGainDb,
      micGain: Number(this.micGain.toFixed(3)),
    });
    this.emitStatus(true);
    return this.getStatus();
  }

  async release(): Promise<AndroidOperatorAudioStatus> {
    this.stopCapture();
    if (!this.monitorRequested) {
      await this.stopMonitorInternal();
    }
    this.emitStatus(true);
    return this.getStatus();
  }

  async startMonitor(): Promise<AndroidOperatorAudioStatus> {
    this.monitorRequested = true;
    if (this.outputSocket && this.monitorSource) {
      this.updateMonitorStateForPtt();
      this.emitStatus(true);
      return this.getStatus();
    }
    if (this.monitorStartPromise) {
      return this.monitorStartPromise;
    }
    this.monitorStartPromise = this.startMonitorInternal().finally(() => {
      this.monitorStartPromise = null;
    });
    return this.monitorStartPromise;
  }

  async stopMonitor(): Promise<AndroidOperatorAudioStatus> {
    this.monitorRequested = false;
    await this.stopMonitorInternal();
    this.emitStatus(true);
    return this.getStatus();
  }

  async destroy(): Promise<void> {
    this.deps.voiceSessionManager.off('voicePttLockChanged', this.handlePttLockChanged);
    this.stopCapture();
    await this.stopMonitorInternal();
    this.removeAllListeners();
  }

  private async prepareInternal(): Promise<AndroidOperatorAudioStatus> {
    const devices = this.requireDevices();
    if (!devices.mic) {
      return this.failCapture('Android native phone microphone is not available');
    }
    this.captureState = 'preparing';
    this.lastError = null;
    this.emitStatus(true);

    const socket = this.inputSocketFactory(devices.mic);
    this.captureSocket = socket;
    socket.on('audioData', this.handleCaptureAudioData);
    socket.on('error', this.handleCaptureError);
    socket.on('close', this.handleCaptureClose);

    try {
      await socket.start();
      if (this.captureSocket !== socket) {
        socket.stop();
        return this.getStatus();
      }
      this.captureState = 'capturing';
      this.lastError = null;
      logger.info('Android native operator capture prepared', {
        device: devices.mic.name,
        socketPath: devices.mic.socketPath,
        sampleRate: devices.mic.sampleRate,
        participantIdentity: PARTICIPANT_IDENTITY,
        micGainDb: this.micGainDb,
        micGain: Number(this.micGain.toFixed(3)),
      });
      this.emitStatus(true);
      return this.getStatus();
    } catch (error) {
      socket.off('audioData', this.handleCaptureAudioData);
      socket.off('error', this.handleCaptureError);
      socket.off('close', this.handleCaptureClose);
      if (this.captureSocket === socket) this.captureSocket = null;
      socket.stop();
      return this.failCapture(errorMessage(error));
    }
  }

  private async startMonitorInternal(): Promise<AndroidOperatorAudioStatus> {
    const devices = this.requireDevices();
    if (!devices.speaker) {
      return this.failMonitor('Android native phone speaker is not available');
    }

    this.monitorState = 'starting';
    this.lastError = null;
    this.emitStatus(true);

    const sampleRate = devices.speaker.sampleRate || 48000;
    const output = this.outputSocketFactory(devices.speaker, { sampleRate, format: 'f32le', channels: 1 });
    try {
      await output.start();
      const source = this.deps.rxAudioRouter.resolveSource('radio');
      if (!source) {
        output.stop();
        return this.failMonitor('Radio monitor audio source is not available');
      }
      this.outputSocket = output;
      this.monitorSource = source;
      source.on('audioFrame', this.handleMonitorAudioFrame);
      this.updateMonitorStateForPtt();
      logger.info('Android native operator monitor started', {
        device: devices.speaker.name,
        socketPath: devices.speaker.socketPath,
        sampleRate,
      });
      this.emitStatus(true);
      return this.getStatus();
    } catch (error) {
      output.stop();
      return this.failMonitor(errorMessage(error));
    }
  }

  private stopCapture(): void {
    const socket = this.captureSocket;
    this.captureSocket = null;
    if (socket) {
      socket.off('audioData', this.handleCaptureAudioData);
      socket.off('error', this.handleCaptureError);
      socket.off('close', this.handleCaptureClose);
      socket.stop();
    }
    this.captureFrameBuffer?.clear();
    this.captureFrameBuffer = null;
    this.captureFrameSampleRate = 0;
    this.captureState = 'idle';
    this.inputLevel = 0;
    this.inputPeak = 0;
    this.rawInputLevel = 0;
    this.rawInputPeak = 0;
  }

  private async stopMonitorInternal(): Promise<void> {
    if (this.monitorSource) {
      this.monitorSource.off('audioFrame', this.handleMonitorAudioFrame);
      this.monitorSource = null;
    }
    this.outputSocket?.stop();
    this.outputSocket = null;
    this.monitorResampler = null;
    this.monitorResamplerKey = '';
    this.monitorState = 'idle';
  }

  private readonly handleCaptureAudioData = (samples: Float32Array, sampleRate: number): void => {
    if (samples.length === 0 || sampleRate <= 0) {
      return;
    }
    const { rms, peak } = calculateLevels(samples);
    const txSamples = this.applyMicGain(samples);
    const boostedLevels = calculateLevels(txSamples);
    const now = Date.now();
    this.rawInputLevel = rms;
    this.rawInputPeak = peak;
    this.inputLevel = boostedLevels.rms;
    this.inputPeak = boostedLevels.peak;
    this.lastInputAtMs = now;
    if (peak > 0.003) {
      this.lastNonSilentInputAtMs = now;
    }

    if (this.captureFrameSampleRate !== sampleRate || !this.captureFrameBuffer) {
      this.captureFrameSampleRate = sampleRate;
      this.captureFrameBuffer = new FixedFrameAudioBuffer(Math.max(1, Math.round(sampleRate * FRAME_DURATION_MS / 1000)));
    }

    const frames = this.captureFrameBuffer.push(txSamples);
    for (const frame of frames) {
      void this.routeCaptureFrame(frame, sampleRate);
    }
    this.emitStatus(false);
  };

  private applyMicGain(samples: Float32Array): Float32Array {
    if (this.micGain === 1) {
      return samples;
    }
    const output = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = (samples[i] ?? 0) * this.micGain;
      output[i] = sample > 1 ? 1 : (sample < -1 ? -1 : sample);
    }
    return output;
  }

  private async routeCaptureFrame(frame: Float32Array, sampleRate: number): Promise<void> {
    if (this.deps.voiceSessionManager.getActiveVoiceAudioClientId() !== PARTICIPANT_IDENTITY) {
      return;
    }
    const now = Date.now();
    const meta: VoiceTxFrameMeta = {
      transport: 'android-native',
      participantIdentity: PARTICIPANT_IDENTITY,
      sequence: this.sequence++,
      clientSentAtMs: null,
      serverReceivedAtMs: now,
      mediaTimestampMs: now,
      frameDurationMs: (frame.length / sampleRate) * 1000,
      codec: 'pcm-s16le',
      sampleRate,
      samplesPerChannel: frame.length,
    };
    await this.deps.voiceSessionManager.handleParticipantAudioFrame(meta, frame);
  }

  private readonly handleMonitorAudioFrame = (frame: RealtimeAudioFrame): void => {
    const output = this.outputSocket;
    if (!output || frame.samples.length === 0 || frame.sampleRate <= 0) {
      return;
    }
    if (this.effectiveMonitorState() === 'paused-for-ptt') {
      return;
    }
    const speaker = this.resolveDevices().speaker;
    const outputRate = speaker?.sampleRate || frame.sampleRate;
    const samples = this.resampleMonitorFrame(frame.samples, frame.sampleRate, outputRate);
    if (samples.length === 0) {
      return;
    }
    void output.write(samples, 1).then((ok) => {
      if (!ok && this.monitorRequested) {
        this.failMonitor('Android native speaker socket write failed');
      }
    });
  };

  private resampleMonitorFrame(samples: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (inputRate === outputRate) return samples;
    const key = `${inputRate}:${outputRate}`;
    if (this.monitorResamplerKey !== key) {
      this.monitorResampler = new StreamingLinearResampler(inputRate, outputRate);
      this.monitorResamplerKey = key;
    }
    return this.monitorResampler?.process(samples) ?? new Float32Array(0);
  }

  private readonly handleCaptureError = (error: Error): void => {
    this.lastError = error.message;
    this.captureState = 'error';
    logger.warn('Android native operator capture error', { error: error.message });
    this.emitStatus(true);
  };

  private readonly handleCaptureClose = (): void => {
    if (this.captureState !== 'idle') {
      this.lastError = 'Android native microphone socket closed';
      this.captureState = 'error';
      this.emitStatus(true);
    }
  };

  private readonly handlePttLockChanged = (_lock: VoicePTTLock): void => {
    this.updateMonitorStateForPtt();
    this.emitStatus(true);
  };

  private updateMonitorStateForPtt(): void {
    if (!this.monitorRequested || !this.outputSocket) {
      this.monitorState = this.monitorRequested ? this.monitorState : 'idle';
      return;
    }
    this.monitorState = this.deps.voiceSessionManager.getPTTLockState().locked ? 'paused-for-ptt' : 'playing';
  }

  private effectiveMonitorState(): MonitorState {
    if (this.monitorState === 'playing' && this.deps.voiceSessionManager.getPTTLockState().locked) {
      return 'paused-for-ptt';
    }
    return this.monitorState;
  }

  private failCapture(message: string): AndroidOperatorAudioStatus {
    this.lastError = message;
    this.captureState = 'error';
    logger.warn('Android native operator capture unavailable', { message });
    this.emitStatus(true);
    return this.getStatus();
  }

  private failMonitor(message: string): AndroidOperatorAudioStatus {
    this.lastError = message;
    this.monitorState = 'error';
    logger.warn('Android native operator monitor unavailable', { message });
    this.emitStatus(true);
    return this.getStatus();
  }

  private requireDevices(): { mic: AndroidAudioDeviceDescriptor | null; speaker: AndroidAudioDeviceDescriptor | null } {
    const devices = this.resolveDevices();
    if (!isAndroidBridgeRuntime()) {
      this.lastError = 'Android native operator audio is only enabled in android-bridge runtime';
    } else if (!devices.mic || !devices.speaker) {
      this.lastError = !devices.mic ? 'Android phone microphone is missing from audio manifest' : 'Android phone speaker is missing from audio manifest';
    }
    return devices;
  }

  private resolveDevices(): { mic: AndroidAudioDeviceDescriptor | null; speaker: AndroidAudioDeviceDescriptor | null } {
    if (!isAndroidBridgeRuntime()) {
      return { mic: null, speaker: null };
    }
    return {
      mic: selectBuiltinDevice(getAndroidAudioDevices('input'), BUILTIN_MIC_KINDS),
      speaker: selectBuiltinDevice(getAndroidAudioDevices('output'), BUILTIN_SPEAKER_KINDS),
    };
  }

  private isInputSilenced(): boolean {
    if (this.captureState !== 'capturing' || this.lastInputAtMs <= 0) {
      return false;
    }
    return Date.now() - this.lastNonSilentInputAtMs > INPUT_SILENCE_HOLD_MS;
  }

  private emitStatus(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastStatusEmitAt < STATUS_LEVEL_EMIT_INTERVAL_MS) {
      return;
    }
    this.lastStatusEmitAt = now;
    this.emit('statusChanged', this.getStatus());
  }
}

function selectBuiltinDevice(
  devices: AndroidAudioDeviceDescriptor[],
  acceptedKinds: Set<string>,
): AndroidAudioDeviceDescriptor | null {
  return devices.find((device) => device.available !== false && acceptedKinds.has(device.kind))
    ?? devices.find((device) => acceptedKinds.has(device.kind))
    ?? null;
}

function toStatusDevice(device: AndroidAudioDeviceDescriptor): AndroidOperatorAudioStatus['micDevice'] {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    socketPath: device.socketPath,
    sampleRate: device.sampleRate || 48000,
    connected: device.connected,
  };
}

function calculateLevels(samples: Float32Array): { rms: number; peak: number } {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Number.isFinite(samples[i]) ? samples[i]! : 0;
    const abs = Math.min(1, Math.abs(sample));
    sumSquares += abs * abs;
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return { rms: clamp01(rms * 2.5), peak: clamp01(peak) };
}

function getMicGainDb(): number {
  const raw = process.env.TX5DR_ANDROID_OPERATOR_MIC_GAIN_DB;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIC_GAIN_DB;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MIC_GAIN_DB;
  return clampMicGainDb(parsed);
}

function clampMicGainDb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIC_GAIN_DB;
  return Math.max(MIN_MIC_GAIN_DB, Math.min(MAX_MIC_GAIN_DB, value));
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
