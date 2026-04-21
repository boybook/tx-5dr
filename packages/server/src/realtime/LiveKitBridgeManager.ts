import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, RemoteAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import type { AudioMonitorService } from '../audio/AudioMonitorService.js';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type {
  RealtimeConnectivityErrorCode,
  RealtimeConnectivityIssue,
  RealtimeScope,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { buildRadioRoomName } from './room-names.js';
import { LiveKitAuthService } from './LiveKitAuthService.js';
import { LiveKitConfig } from './LiveKitConfig.js';
import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';

const logger = createLogger('LiveKitBridge');
const LIVEKIT_AUDIO_SAMPLE_RATE = 16000;
const LIVEKIT_AUDIO_CHANNELS = 1;
const LIVEKIT_AUDIO_QUEUE_MS = 60;
const LIVEKIT_AUDIO_MAX_QUEUED_MS = 90;
const LIVEKIT_NO_AUDIO_WARNING_MS = 5000;
const LIVEKIT_RECOVERY_PROBE_INTERVAL_MS = 30_000;

function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] || 0));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = samples[i]! / 32768;
  }
  return out;
}

interface PublishedAudioState {
  room: Room;
  audioSource: AudioSource;
  track: LocalAudioTrack;
  cleanupMonitor: (() => void) | null;
  boundMonitor: AudioMonitorService | null;
  roomName: string;
}

interface ScopeHealthState {
  healthy: boolean;
  updatedAt: number;
  issueCode: RealtimeConnectivityErrorCode | null;
}

export class LiveKitBridgeManager {
  private readonly authService = new LiveKitAuthService();
  private radioState: PublishedAudioState | null = null;
  private remoteTrackReaders = new Map<string, ReadableStreamDefaultReader<AudioFrame>>();
  private isStarted = false;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryInProgress = false;
  private readonly scopeHealth = new Map<RealtimeScope, ScopeHealthState>([
    ['radio', { healthy: true, updatedAt: Date.now(), issueCode: null }],
  ]);

  constructor(private readonly engine: DigitalRadioEngine) {}

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    if (!LiveKitConfig.isEnabled()) {
      this.markScopeUnhealthy('radio', 'SIGNALING_UNREACHABLE');
      LiveKitConfig.setRuntimeAvailable(false, 'disabled-by-config');
      logger.info('LiveKit bridge manager disabled by configuration');
      return;
    }

    try {
      await this.ensureRadioRoom();
      this.bindRadioAudioMonitor();
      this.markScopeHealthy('radio');
      LiveKitConfig.setRuntimeAvailable(true);
    } catch (error) {
      this.reportBridgeIssue('radio', 'runtime', 'SIGNALING_UNREACHABLE', 'Server bridge could not connect to LiveKit for radio audio', error);
      LiveKitConfig.setRuntimeAvailable(false, 'signaling-unreachable');
      this.startRecoveryProbe();
    }

    this.engine.on('profileChanged' as never, () => {
      void this.handleProfileChanged();
    });
    this.engine.on('systemStatus' as never, () => {
      this.bindRadioAudioMonitor();
    });
    // AudioSidecarController owns AudioMonitorService and creates/destroys it
    // asynchronously as the local audio stream retries. Rebind on every status
    // change so the bridge latches onto the freshly created instance once the
    // sidecar enters `connected` (systemStatus alone fires before the sidecar
    // is ready, so the initial bind would see a null service and never retry).
    this.engine.on('audioSidecarStatusChanged' as never, () => {
      this.bindRadioAudioMonitor();
    });

    logger.info('LiveKit bridge manager started', {
      runtimeAvailable: LiveKitConfig.isRuntimeAvailable(),
    });
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.isStarted = false;

    this.stopRecoveryProbe();

    await this.disconnectPublishedState(this.radioState);
    this.radioState = null;

    for (const [key, reader] of this.remoteTrackReaders.entries()) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      this.remoteTrackReaders.delete(key);
    }

    logger.info('LiveKit bridge manager stopped');
  }

  private async handleProfileChanged(): Promise<void> {
    try {
      await this.ensureRadioRoom(true);
      this.bindRadioAudioMonitor();
      this.markScopeHealthy('radio');
    } catch (error) {
      this.reportBridgeIssue('radio', 'runtime', 'SIGNALING_UNREACHABLE', 'Server bridge failed to reconnect after profile change', error);
    }
  }

  private async ensureRadioRoom(forceReconnect = false): Promise<void> {
    const activeProfileId = ConfigManager.getInstance().getActiveProfileId();
    const roomName = buildRadioRoomName(activeProfileId);

    if (!forceReconnect && this.radioState?.roomName === roomName) {
      return;
    }

    await this.disconnectPublishedState(this.radioState);
    this.radioState = await this.createPublishedState(roomName);
  }

  private bindRadioAudioMonitor(): void {
    if (!this.radioState) return;
    const audioMonitorService = this.engine.getAudioMonitorService();

    // Rebind only when the monitor instance actually changes. Audio sidecar
    // keeps the monitor stable across retries now, so sidecar status ticks do
    // not need to teardown/reinstall the audioData listener (which would
    // otherwise reset the "no audio" warning timer on every transition).
    if (this.radioState.boundMonitor === audioMonitorService) {
      return;
    }

    this.radioState.cleanupMonitor?.();
    this.radioState.cleanupMonitor = this.bindPublishedAudioSource(this.radioState.audioSource, audioMonitorService, {
      roomName: this.radioState.roomName,
      scope: 'radio',
    });
    this.radioState.boundMonitor = audioMonitorService;
  }

  private bindPublishedAudioSource(
    audioSource: AudioSource,
    audioMonitorService: AudioMonitorService | null,
    context: { roomName: string; scope: 'radio' },
  ): (() => void) | null {
    if (!audioMonitorService) {
      return null;
    }

    let latestFrame: AudioFrame | null = null;
    let draining = false;
    let disposed = false;
    let latestFrameAgeMs = 0;
    let receivedFrames = 0;
    let capturedFrames = 0;
    let replacedFrames = 0;
    let clearedBacklogCount = 0;
    const noAudioWarningTimer = setTimeout(() => {
      if (disposed || receivedFrames > 0) {
        return;
      }
      this.reportBridgeIssue(
        context.scope,
        'runtime',
        'NO_AUDIO_TRACK',
        'Server bridge did not receive any audio frames from the monitored source',
        new Error(`No monitored audio frames received within ${LIVEKIT_NO_AUDIO_WARNING_MS}ms`),
      );
    }, LIVEKIT_NO_AUDIO_WARNING_MS);

    const drainFrames = async (): Promise<void> => {
      if (draining || disposed) {
        return;
      }
      draining = true;

      try {
        while (latestFrame && !disposed) {
          const frame = latestFrame;
          latestFrame = null;
          const queuedBeforeMs = audioSource.queuedDuration;

          if (queuedBeforeMs > LIVEKIT_AUDIO_MAX_QUEUED_MS) {
            clearedBacklogCount += 1;
            logger.warn('LiveKit audio source queue too large, clearing backlog', {
              roomName: context.roomName,
              scope: context.scope,
              queuedDurationMs: Number(queuedBeforeMs.toFixed(1)),
              sourceFrameAgeMs: Number(latestFrameAgeMs.toFixed(1)),
              receivedFrames,
              capturedFrames,
              replacedFrames,
              clearedBacklogCount,
            });
            audioSource.clearQueue();
          }

          await audioSource.captureFrame(frame);
          capturedFrames += 1;
        }
      } catch (error: unknown) {
        logger.debug('Failed to capture audio frame for LiveKit source', error);
      } finally {
        draining = false;
        if (latestFrame && !disposed) {
          void drainFrames();
        }
      }
    };

    const handleAudioData = (data: {
      audioData: ArrayBuffer;
      sampleRate: number;
      samples: number;
      timestamp: number;
      sequence: number;
    }) => {
      const floatSamples = new Float32Array(data.audioData);
      if (floatSamples.length === 0) return;
      receivedFrames += 1;
      if (receivedFrames === 1) {
        clearTimeout(noAudioWarningTimer);
      }
      if (latestFrame) {
        replacedFrames += 1;
      }
      latestFrameAgeMs = Date.now() - data.timestamp;

      latestFrame = new AudioFrame(
        float32ToInt16(floatSamples),
        data.sampleRate,
        1,
        data.samples,
      );
      void drainFrames();
    };

    audioMonitorService.on('audioData', handleAudioData);
    return () => {
      disposed = true;
      clearTimeout(noAudioWarningTimer);
      latestFrame = null;
      audioMonitorService.off('audioData', handleAudioData);
    };
  }

  private reportBridgeIssue(
    scope: RealtimeScope,
    stage: RealtimeConnectivityIssue['stage'],
    code: RealtimeConnectivityErrorCode,
    userMessage: string,
    error: unknown,
  ): void {
    this.scopeHealth.set(scope, {
      healthy: false,
      updatedAt: Date.now(),
      issueCode: code,
    });

    // If the radio scope is unhealthy due to signaling, mark runtime unavailable and start recovery
    if (scope === 'radio' && code === 'SIGNALING_UNREACHABLE') {
      LiveKitConfig.setRuntimeAvailable(false, 'signaling-unreachable');
      this.startRecoveryProbe();
    }

    const hints = LiveKitConfig.getConnectivityHints();
    const issue: RealtimeConnectivityIssue = {
      code,
      scope,
      stage,
      userMessage,
      suggestions: [
        `Check LiveKit signaling port ${hints.signalingPort}`,
        `Check LiveKit ICE/TCP port ${hints.rtcTcpPort}`,
        `Check LiveKit UDP range ${hints.udpPortRange}`,
        `Verify client and server can reach ${hints.signalingUrl}`,
      ],
      technicalDetails: error instanceof Error ? error.message : String(error),
      context: {
        signalingUrl: hints.signalingUrl,
        signalingPort: String(hints.signalingPort),
        rtcTcpPort: String(hints.rtcTcpPort),
        udpPortRange: hints.udpPortRange,
      },
    };

    logger.warn('LiveKit bridge issue detected', issue);
    this.engine.emit('realtimeConnectivityIssue', issue);
  }

  private markScopeHealthy(scope: RealtimeScope): void {
    this.scopeHealth.set(scope, {
      healthy: true,
      updatedAt: Date.now(),
      issueCode: null,
    });
  }

  private markScopeUnhealthy(scope: RealtimeScope, issueCode: RealtimeConnectivityErrorCode): void {
    this.scopeHealth.set(scope, {
      healthy: false,
      updatedAt: Date.now(),
      issueCode,
    });
  }

  getScopeHealth(scope: RealtimeScope): ScopeHealthState {
    return this.scopeHealth.get(scope) ?? {
      healthy: true,
      updatedAt: Date.now(),
      issueCode: null,
    };
  }

  private startRecoveryProbe(): void {
    if (this.recoveryTimer) return;
    if (!LiveKitConfig.isEnabled()) return;

    logger.info('Starting LiveKit recovery probe', { intervalMs: LIVEKIT_RECOVERY_PROBE_INTERVAL_MS });
    this.recoveryTimer = setInterval(() => {
      void this.attemptRecovery();
    }, LIVEKIT_RECOVERY_PROBE_INTERVAL_MS);
  }

  private stopRecoveryProbe(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private async attemptRecovery(): Promise<void> {
    if (this.recoveryInProgress) return;
    if (!this.isStarted || !LiveKitConfig.isEnabled()) {
      this.stopRecoveryProbe();
      return;
    }
    if (LiveKitConfig.isRuntimeAvailable()) {
      this.stopRecoveryProbe();
      return;
    }

    this.recoveryInProgress = true;
    logger.debug('Attempting LiveKit recovery probe');
    try {
      await this.ensureRadioRoom(true);
      this.bindRadioAudioMonitor();
      this.markScopeHealthy('radio');
      LiveKitConfig.setRuntimeAvailable(true);
      this.stopRecoveryProbe();
      logger.info('LiveKit recovered, runtime now available');
    } catch (error) {
      logger.debug('LiveKit recovery probe failed, will retry', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.recoveryInProgress = false;
    }
  }

  private async createPublishedState(
    roomName: string,
  ): Promise<PublishedAudioState> {
    const room = new Room();
    const token = await this.authService.issueBridgeToken({
      roomName,
      scope: 'radio',
      participantName: 'TX-5DR Radio Bridge',
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) {
        return;
      }

      const trackId = `${participant.identity}:${publication.sid}`;
      const stream = new AudioStream(track as RemoteAudioTrack, {
        sampleRate: LIVEKIT_AUDIO_SAMPLE_RATE,
        numChannels: LIVEKIT_AUDIO_CHANNELS,
      });
      const reader = stream.getReader();
      this.remoteTrackReaders.set(trackId, reader);

      void this.consumeRemoteTrack(trackId, participant.identity, reader);
    });

    room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      const trackId = `${participant.identity}:${publication.sid}`;
      const reader = this.remoteTrackReaders.get(trackId);
      if (reader) {
        void reader.cancel().catch(() => {});
        this.remoteTrackReaders.delete(trackId);
      }
    });

    await room.connect(token.url, token.token, { autoSubscribe: true, dynacast: false });

    const audioSource = new AudioSource(
      LIVEKIT_AUDIO_SAMPLE_RATE,
      LIVEKIT_AUDIO_CHANNELS,
      LIVEKIT_AUDIO_QUEUE_MS,
    );
    const track = LocalAudioTrack.createAudioTrack('radio-rx', audioSource);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant!.publishTrack(track, publishOptions);

    logger.info('LiveKit bridge connected', {
      roomName,
      scope: 'radio',
      audioSampleRate: LIVEKIT_AUDIO_SAMPLE_RATE,
      queueTargetMs: LIVEKIT_AUDIO_QUEUE_MS,
      queueMaxMs: LIVEKIT_AUDIO_MAX_QUEUED_MS,
    });

    return {
      room,
      audioSource,
      track,
      cleanupMonitor: null,
      boundMonitor: null,
      roomName,
    };
  }

  private async consumeRemoteTrack(
    trackId: string,
    participantIdentity: string,
    reader: ReadableStreamDefaultReader<AudioFrame>,
  ): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) {
          break;
        }

        const frame = int16ToFloat32(value.data);
        const meta: VoiceTxFrameMeta = {
          transport: 'livekit',
          participantIdentity,
          sequence: null,
          clientSentAtMs: null,
          serverReceivedAtMs: Date.now(),
          sampleRate: value.sampleRate,
          samplesPerChannel: value.samplesPerChannel,
        };
        await this.engine.getVoiceSessionManager()?.handleParticipantAudioFrame(meta, frame);
      }
    } catch (error) {
      logger.debug('LiveKit remote track reader ended with error', { trackId, error });
    } finally {
      const current = this.remoteTrackReaders.get(trackId);
      if (current === reader) {
        this.remoteTrackReaders.delete(trackId);
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private async disconnectPublishedState(state: PublishedAudioState | null): Promise<void> {
    if (!state) return;

    state.cleanupMonitor?.();
    state.cleanupMonitor = null;
    state.boundMonitor = null;

    try {
      await state.room.disconnect();
    } catch (error) {
      logger.warn('Failed to disconnect LiveKit bridge room', { roomName: state.roomName, error });
    }

    try {
      await state.track.close();
    } catch {
      // ignore
    }

    try {
      await state.audioSource.close();
    } catch {
      // ignore
    }
  }
}
