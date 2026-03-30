import { useRef, useState, useCallback, useEffect } from 'react';
import { Room, RoomEvent, Track, type RemoteAudioTrack } from 'livekit-client';
import { api } from '@tx5dr/core';
import { decodeWsCompatAudioFrame, int16ToFloat32Pcm } from '@tx5dr/core';
import type {
  RealtimeConnectivityHints,
  RealtimeScope,
  RealtimeSourceStats,
  RealtimeTransportKind,
  RealtimeTransportOffer,
} from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';
import {
  buildRealtimeConnectivityIssue,
  showRealtimeFallbackActivatedToast,
  toRealtimeConnectivityError,
} from '../realtime/realtimeConnectivity';

const logger = createLogger('useAudioMonitorPlayback');
const STATS_POLL_INTERVAL_MS = 1000;
const AUDIO_TRACK_WAIT_TIMEOUT_MS = 5000;
const LIVEKIT_FAST_WEBSOCKET_TIMEOUT_MS = 1500;
const LIVEKIT_FAST_PEER_TIMEOUT_MS = 2000;
const LIVEKIT_FAST_TRACK_TIMEOUT_MS = 1500;

interface ReceiverStatsData {
  latencyMs?: number;
  jitterMs?: number;
  packetsLost?: number;
  packetsReceived?: number;
  bitrateKbps?: number;
  concealedSamples?: number;
  droppedSamples?: number;
  bufferFillPercent?: number;
  queueDurationMs?: number;
  targetBufferMs?: number;
}

export interface MonitorStatsData {
  latencyMs: number;
  bufferFillPercent: number;
  isActive: boolean;
  source?: RealtimeSourceStats | null;
  receiver?: ReceiverStatsData | null;
}

export interface UseAudioMonitorPlaybackOptions {
  scope: RealtimeScope;
  previewSessionId?: string | null;
}

export interface UseAudioMonitorPlaybackReturn {
  isPlaying: boolean;
  start: (overridePreviewSessionId?: string) => Promise<void>;
  stop: () => void;
  stats: MonitorStatsData | null;
  setVolume: (db: number) => void;
  codec: 'webrtc' | 'pcm/ws';
  transportKind: RealtimeTransportKind | null;
}

export function useAudioMonitorPlayback(
  options: UseAudioMonitorPlaybackOptions
): UseAudioMonitorPlaybackReturn {
  const { scope, previewSessionId } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [stats, setStats] = useState<MonitorStatsData | null>(null);
  const [transportKind, setTransportKind] = useState<RealtimeTransportKind | null>(null);
  const roomRef = useRef<Room | null>(null);
  const attachedTracksRef = useRef<Map<string, RemoteAudioTrack>>(new Map());
  const attachedElementsRef = useRef<Map<string, HTMLMediaElement>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compatSocketRef = useRef<WebSocket | null>(null);
  const isInitializingRef = useRef(false);
  const currentVolumeRef = useRef(1);
  const sourceStatsRef = useRef<RealtimeSourceStats | null>(null);
  const receiverStatsRef = useRef<ReceiverStatsData | null>(null);
  const statsPollTimerRef = useRef<number | null>(null);
  const displayLatencyRef = useRef<number | null>(null);
  const displayBufferFillRef = useRef<number | null>(null);
  const activePreviewSessionIdRef = useRef<string | null>(previewSessionId ?? null);
  const connectivityHintsRef = useRef<RealtimeConnectivityHints | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const pendingTrackWaitersRef = useRef<Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  }>>([]);

  const resolvePendingTrackWaiters = useCallback(() => {
    const waiters = pendingTrackWaitersRef.current.splice(0);
    waiters.forEach(({ resolve, timer }) => {
      window.clearTimeout(timer);
      resolve();
    });
  }, [transportKind]);

  const rejectPendingTrackWaiters = useCallback((message: string) => {
    const waiters = pendingTrackWaitersRef.current.splice(0);
    waiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(new Error(message));
    });
  }, []);

  const waitForPlaybackPath = useCallback(async (timeoutMs = AUDIO_TRACK_WAIT_TIMEOUT_MS): Promise<void> => {
    if (attachedTracksRef.current.size > 0 || compatSocketRef.current) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingTrackWaitersRef.current = pendingTrackWaitersRef.current.filter((entry) => entry.timer !== timer);
        reject(new Error('No realtime audio path became available before timeout'));
      }, timeoutMs);

      pendingTrackWaitersRef.current.push({ resolve, reject, timer });
    });
  }, []);

  const detachAllTracks = useCallback(() => {
    attachedTracksRef.current.forEach((track, key) => {
      try {
        track.detach();
      } catch {
        // ignore
      }

      const element = attachedElementsRef.current.get(key);
      if (element?.parentElement) {
        element.parentElement.removeChild(element);
      }
    });

    attachedTracksRef.current.clear();
    attachedElementsRef.current.clear();
  }, []);

  const cleanupTransportState = useCallback((preserveSessionContext = false) => {
    if (statsPollTimerRef.current !== null) {
      window.clearInterval(statsPollTimerRef.current);
      statsPollTimerRef.current = null;
    }

    detachAllTracks();
    rejectPendingTrackWaiters('Realtime playback stopped before audio path became available');

    if (compatSocketRef.current) {
      try {
        compatSocketRef.current.close();
      } catch {
        // ignore
      }
      compatSocketRef.current = null;
    }

    if (roomRef.current) {
      void roomRef.current.disconnect();
      roomRef.current = null;
    }

    if (workletNodeRef.current) {
      try {
        workletNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current = null;
    }

    if (gainNodeRef.current) {
      try {
        gainNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      gainNodeRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    sourceStatsRef.current = null;
    receiverStatsRef.current = null;
    displayLatencyRef.current = null;
    displayBufferFillRef.current = null;
    setTransportKind(null);
    setIsPlaying(false);
    setStats(null);

    if (!preserveSessionContext) {
      connectivityHintsRef.current = null;
      activePreviewSessionIdRef.current = null;
      isInitializingRef.current = false;
    }
  }, [detachAllTracks, rejectPendingTrackWaiters]);

  const cleanup = useCallback(() => {
    cleanupTransportState(false);
  }, [cleanupTransportState]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const recomputeStats = useCallback(() => {
    const source = sourceStatsRef.current;
    const receiver = receiverStatsRef.current;

    if (!source && !receiver) {
      return;
    }

    const rawLatencyMs = Math.max(
      0,
      (source?.latencyMs ?? 0) + (receiver?.latencyMs ?? receiver?.jitterMs ?? 0),
    );
    const rawBufferFillPercent = receiver?.bufferFillPercent
      ?? source?.bufferFillPercent
      ?? 0;
    let latencyMs = rawLatencyMs;
    let bufferFillPercent = rawBufferFillPercent;

    if (transportKind === 'ws-compat') {
      const sourceLatencyMs = source?.latencyMs ?? 0;
      const targetBufferMs = receiver?.targetBufferMs ?? 80;
      const queueDurationMs = receiver?.queueDurationMs ?? receiver?.latencyMs ?? 0;
      const effectiveQueueMs = Math.min(queueDurationMs, targetBufferMs);
      const stableLatencyMs = Math.max(0, sourceLatencyMs + effectiveQueueMs);
      const stableBufferFillPercent = Math.max(
        0,
        Math.min(100, (effectiveQueueMs / Math.max(targetBufferMs, 1)) * 100),
      );
      const alpha = 0.35;

      latencyMs = displayLatencyRef.current == null
        ? stableLatencyMs
        : (displayLatencyRef.current * (1 - alpha)) + (stableLatencyMs * alpha);
      bufferFillPercent = displayBufferFillRef.current == null
        ? stableBufferFillPercent
        : (displayBufferFillRef.current * (1 - alpha)) + (stableBufferFillPercent * alpha);

      displayLatencyRef.current = latencyMs;
      displayBufferFillRef.current = bufferFillPercent;
    } else {
      displayLatencyRef.current = rawLatencyMs;
      displayBufferFillRef.current = rawBufferFillPercent;
    }

    const isActive = source?.isActive ?? (attachedTracksRef.current.size > 0 || Boolean(compatSocketRef.current));

    setStats({
      latencyMs,
      bufferFillPercent,
      isActive,
      source,
      receiver,
    });
  }, []);

  const pollSourceStats = useCallback(async () => {
    try {
      const response = await api.getRealtimeStats({
        scope,
        ...(scope === 'openwebrx-preview' && activePreviewSessionIdRef.current
          ? { previewSessionId: activePreviewSessionIdRef.current }
          : {}),
      });
      sourceStatsRef.current = response.source ?? null;
      recomputeStats();
    } catch (error) {
      logger.debug('Failed to poll source monitor stats', error);
    }
  }, [recomputeStats, scope]);

  const pollReceiverStats = useCallback(async () => {
    if (transportKind === 'ws-compat') {
      recomputeStats();
      return;
    }

    const firstTrack = attachedTracksRef.current.values().next().value as RemoteAudioTrack | undefined;
    if (!firstTrack) {
      receiverStatsRef.current = null;
      recomputeStats();
      return;
    }

    try {
      const report = await firstTrack.getRTCStatsReport();
      let receiver: ReceiverStatsData | null = null;

      report?.forEach((entry) => {
        if (entry.type !== 'inbound-rtp') {
          return;
        }

        const inbound = entry as RTCInboundRtpStreamStats & {
          jitterBufferEmittedCount?: number;
        };
        const emittedCount = inbound.jitterBufferEmittedCount ?? 0;
        const latencyMs = emittedCount > 0 && typeof inbound.jitterBufferDelay === 'number'
          ? (inbound.jitterBufferDelay / emittedCount) * 1000
          : undefined;

        receiver = {
          latencyMs,
          jitterMs: typeof inbound.jitter === 'number' ? inbound.jitter * 1000 : undefined,
          packetsLost: inbound.packetsLost,
          packetsReceived: inbound.packetsReceived,
          bitrateKbps: Number.isFinite(firstTrack.currentBitrate) ? firstTrack.currentBitrate / 1000 : undefined,
          concealedSamples: inbound.concealedSamples,
        };
      });

      receiverStatsRef.current = receiver;
      recomputeStats();
    } catch (error) {
      logger.debug('Failed to poll receiver monitor stats', error);
    }
  }, [recomputeStats, transportKind]);

  const startStatsPolling = useCallback(() => {
    if (statsPollTimerRef.current !== null) {
      window.clearInterval(statsPollTimerRef.current);
    }

    void pollSourceStats();
    void pollReceiverStats();

    statsPollTimerRef.current = window.setInterval(() => {
      void pollSourceStats();
      void pollReceiverStats();
    }, STATS_POLL_INTERVAL_MS);
  }, [pollReceiverStats, pollSourceStats]);

  const attachRemoteTrack = useCallback((key: string, track: RemoteAudioTrack) => {
    if (attachedTracksRef.current.has(key)) {
      return;
    }

    track.setPlayoutDelay(0);
    track.setVolume(currentVolumeRef.current);

    const element = track.attach();
    element.autoplay = true;
    element.setAttribute('playsinline', 'true');
    element.style.display = 'none';
    document.body.appendChild(element);

    attachedTracksRef.current.set(key, track);
    attachedElementsRef.current.set(key, element);
    resolvePendingTrackWaiters();
    void pollReceiverStats();
    recomputeStats();
  }, [pollReceiverStats, recomputeStats, resolvePendingTrackWaiters]);

  const attachBridgeTrackPublication = useCallback((
    participantIdentity: string,
    publication: { trackSid?: string; trackName?: string; track?: { kind?: string } | null },
  ) => {
    if (!participantIdentity.startsWith('bridge:')) {
      return;
    }

    if (!publication.track || publication.track.kind !== Track.Kind.Audio) {
      return;
    }

    const key = publication.trackSid || `${participantIdentity}:${publication.trackName || 'audio'}`;
    attachRemoteTrack(key, publication.track as RemoteAudioTrack);
  }, [attachRemoteTrack]);

  const attachExistingBridgeTracks = useCallback((room: Room) => {
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        attachBridgeTrackPublication(participant.identity, publication);
      });
    });
  }, [attachBridgeTrackPublication]);

  const startLiveKitPlayback = useCallback(async (
    offer: RealtimeTransportOffer,
    options?: { fastFallback?: boolean },
  ) => {
    const audioContext = new AudioContext({
      latencyHint: 'interactive',
    });
    audioContextRef.current = audioContext;

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      webAudioMix: {
        audioContext,
      },
    });
    const handleDisconnected = () => {
      if (!intentionalDisconnectRef.current && roomRef.current === room) {
        cleanup();
      }
    };

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      attachBridgeTrackPublication(participant.identity, {
        trackSid: publication.trackSid,
        trackName: publication.trackName,
        track,
      });
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) {
        return;
      }

      const key = publication.trackSid || `${participant.identity}:${publication.trackName}`;
      const existingTrack = attachedTracksRef.current.get(key);
      if (existingTrack) {
        try {
          existingTrack.detach();
        } catch {
          // ignore
        }
      }

      const element = attachedElementsRef.current.get(key);
      if (element?.parentElement) {
        element.parentElement.removeChild(element);
      }

      attachedTracksRef.current.delete(key);
      attachedElementsRef.current.delete(key);
      void pollReceiverStats();
      recomputeStats();
    });
    room.on(RoomEvent.Disconnected, handleDisconnected);

    try {
      await room.connect(offer.url, offer.token, {
        autoSubscribe: true,
        maxRetries: options?.fastFallback ? 0 : undefined,
        websocketTimeout: options?.fastFallback ? LIVEKIT_FAST_WEBSOCKET_TIMEOUT_MS : undefined,
        peerConnectionTimeout: options?.fastFallback ? LIVEKIT_FAST_PEER_TIMEOUT_MS : undefined,
      });

      if (!room.canPlaybackAudio) {
        await room.startAudio();
      }

      attachExistingBridgeTracks(room);
      await waitForPlaybackPath(options?.fastFallback ? LIVEKIT_FAST_TRACK_TIMEOUT_MS : AUDIO_TRACK_WAIT_TIMEOUT_MS);
      roomRef.current = room;
      setTransportKind('livekit');
      resolvePendingTrackWaiters();
    } catch (error) {
      room.off(RoomEvent.Disconnected, handleDisconnected);
      try {
        await room.disconnect();
      } catch {
        // ignore
      }
      throw error;
    }
  }, [attachBridgeTrackPublication, attachExistingBridgeTracks, cleanup, pollReceiverStats, recomputeStats, resolvePendingTrackWaiters, waitForPlaybackPath]);

  const startCompatPlayback = useCallback(async (offer: RealtimeTransportOffer) => {
    const audioContext = new AudioContext({
      latencyHint: 'interactive',
    });
    audioContextRef.current = audioContext;

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    await audioContext.audioWorklet.addModule('/audio-monitor-worklet.js');
    const worklet = new AudioWorkletNode(audioContext, 'audio-monitor-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gainNode = audioContext.createGain();
    gainNode.gain.value = currentVolumeRef.current;
    worklet.connect(gainNode);
    gainNode.connect(audioContext.destination);

    worklet.port.onmessage = (event) => {
      if (event.data?.type !== 'stats') {
        return;
      }
      receiverStatsRef.current = {
        latencyMs: event.data.data?.latencyMs,
        bufferFillPercent: event.data.data?.bufferFillPercent,
        droppedSamples: event.data.data?.droppedSamples,
        queueDurationMs: event.data.data?.queueDurationMs,
        targetBufferMs: event.data.data?.targetBufferMs,
      };
      recomputeStats();
    };

    workletNodeRef.current = worklet;
    gainNodeRef.current = gainNode;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${offer.url}?token=${encodeURIComponent(offer.token)}`);
      ws.binaryType = 'arraybuffer';
      compatSocketRef.current = ws;
      let settled = false;

      const timer = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error('Realtime compatibility playback timed out before audio frames arrived'));
      }, AUDIO_TRACK_WAIT_TIMEOUT_MS);

      ws.onopen = () => {
        setTransportKind('ws-compat');
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          return;
        }

        try {
          const decoded = decodeWsCompatAudioFrame(event.data as ArrayBuffer);
          const float32 = int16ToFloat32Pcm(decoded.pcm);
          worklet.port.postMessage({
            type: 'audioData',
            buffer: float32.buffer,
            sampleRate: decoded.sampleRate,
            clientTimestamp: decoded.timestampMs,
          }, [float32.buffer]);

          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            resolvePendingTrackWaiters();
            resolve();
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error('Realtime compatibility WebSocket failed'));
        }
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error('Realtime compatibility playback closed before ready'));
        }
      };
    });

    if (compatSocketRef.current) {
      compatSocketRef.current.onclose = () => {
        if (!intentionalDisconnectRef.current) {
          cleanup();
        }
      };
    }
  }, [recomputeStats, resolvePendingTrackWaiters]);

  const start = useCallback(async (overridePreviewSessionId?: string) => {
    if (isPlaying || isInitializingRef.current) return;
    const effectivePreviewSessionId = overridePreviewSessionId ?? previewSessionId;
    let errorStage: 'token' | 'connect' | 'subscribe' = 'token';
    let compatFallbackAttempted = false;
    let liveKitFailureIssue: ReturnType<typeof buildRealtimeConnectivityIssue> | null = null;

    if (scope === 'openwebrx-preview' && !effectivePreviewSessionId) {
      throw new Error('previewSessionId is required for OpenWebRX preview playback');
    }

    isInitializingRef.current = true;
    intentionalDisconnectRef.current = false;
    activePreviewSessionIdRef.current = effectivePreviewSessionId ?? null;

    try {
      const session = await api.getRealtimeSession({
        scope,
        direction: 'recv',
        ...(effectivePreviewSessionId ? { previewSessionId: effectivePreviewSessionId } : {}),
      });
      connectivityHintsRef.current = session.connectivityHints;

      let lastError: unknown = null;
      for (const offer of session.offers) {
        try {
          errorStage = 'connect';
          if (offer.transport === 'livekit') {
            await startLiveKitPlayback(offer, {
              fastFallback: session.offers.some((candidate) => candidate.transport === 'ws-compat'),
            });
          } else {
            compatFallbackAttempted = liveKitFailureIssue !== null;
            await startCompatPlayback(offer);
            if (liveKitFailureIssue) {
              showRealtimeFallbackActivatedToast(liveKitFailureIssue);
            }
          }
          startStatsPolling();
          setIsPlaying(true);
          return;
        } catch (error) {
          lastError = error;
          if (offer.transport === 'livekit') {
            liveKitFailureIssue = buildRealtimeConnectivityIssue(error, {
              scope,
              stage: errorStage,
              hints: connectivityHintsRef.current ?? undefined,
            });
            logger.warn('LiveKit playback path failed, trying compatibility fallback', {
              scope,
              code: liveKitFailureIssue.code,
              details: liveKitFailureIssue.technicalDetails,
            });
          }
          cleanupTransportState(true);
          if (intentionalDisconnectRef.current) {
            throw error;
          }
        }
      }

      throw lastError ?? new Error('No realtime playback transport succeeded');
    } catch (error) {
      const currentHints = connectivityHintsRef.current ?? undefined;
      const realtimeError = toRealtimeConnectivityError(error, {
        scope,
        stage: errorStage,
        hints: currentHints,
      });
      if (!realtimeError.issue.context) {
        realtimeError.issue.context = {};
      }
      realtimeError.issue.context.compatFallbackAttempted = String(compatFallbackAttempted);
      intentionalDisconnectRef.current = true;
      cleanup();
      logger.error('Failed to start realtime playback', error);
      throw realtimeError;
    } finally {
      isInitializingRef.current = false;
    }
  }, [cleanup, cleanupTransportState, isPlaying, previewSessionId, scope, startCompatPlayback, startLiveKitPlayback, startStatsPolling]);

  const stop = useCallback(() => {
    intentionalDisconnectRef.current = true;
    cleanup();
  }, [cleanup]);

  const setVolume = useCallback((db: number) => {
    const linear = Math.max(0, Math.pow(10, db / 20));
    currentVolumeRef.current = linear;
    attachedTracksRef.current.forEach((track) => {
      track.setVolume(linear);
    });
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = linear;
    }
  }, []);

  return {
    isPlaying,
    start,
    stop,
    stats,
    setVolume,
    codec: transportKind === 'ws-compat' ? 'pcm/ws' : 'webrtc',
    transportKind,
  };
}
