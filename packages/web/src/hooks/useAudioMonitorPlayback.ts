import { useRef, useState, useCallback, useEffect } from 'react';
import { Room, RoomEvent, Track, type RemoteAudioTrack } from 'livekit-client';
import { api } from '@tx5dr/core';
import { decodeWsCompatAudioFrame, int16ToFloat32Pcm } from '@tx5dr/core';
import type {
  RealtimeScope,
  RealtimeSourceStats,
  RealtimeTransportKind,
  RealtimeTransportOffer,
} from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';
import { normalizeWsUrl } from '../utils/config';
import {
  createCompatPlaybackBackend,
  type CompatPlaybackBackend,
  type CompatPlaybackStats,
} from '../audio/compatAudioBackends';
import {
  ensureInteractiveAudioContext,
  closeAudioContext,
} from '../audio/audioRuntime';
import { executeRealtimeSessionFlow } from '../realtime/realtimeSessionFlow';
import { showRealtimeTransportFallbackToast } from '../realtime/realtimeConnectivity';

const logger = createLogger('useAudioMonitorPlayback');
const STATS_POLL_INTERVAL_MS = 1000;
const AUDIO_TRACK_WAIT_TIMEOUT_MS = 5000;
const TRANSPORT_SWITCH_DRAIN_TIMEOUT_MS = 1200;

type InboundRtpStatsLike = {
  jitterBufferEmittedCount?: number;
  jitterBufferDelay?: number;
  jitter?: number;
  packetsLost?: number;
  packetsReceived?: number;
  concealedSamples?: number;
};

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

function waitForSocketClosed(socket: WebSocket, timeoutMs = TRANSPORT_SWITCH_DRAIN_TIMEOUT_MS): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const previousOnClose = socket.onclose;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.onclose = previousOnClose;
      resolve();
    };

    socket.onclose = (event) => {
      previousOnClose?.call(socket, event);
      finish();
    };

    window.setTimeout(finish, timeoutMs);
  });
}

function waitForRoomDisconnected(room: Room, timeoutMs = TRANSPORT_SWITCH_DRAIN_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      room.off(RoomEvent.Disconnected, finish);
      resolve();
    };

    room.on(RoomEvent.Disconnected, finish);
    window.setTimeout(finish, timeoutMs);
  });
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

export interface AudioMonitorStartOptions {
  previewSessionId?: string;
  transportOverride?: RealtimeTransportKind;
}

export interface UseAudioMonitorPlaybackReturn {
  preparePlaybackFromGesture: () => Promise<void>;
  startFromGesture: (options?: string | AudioMonitorStartOptions) => Promise<RealtimeTransportKind>;
  switchTransportFromGesture: (
    transport: RealtimeTransportKind,
    options?: Omit<AudioMonitorStartOptions, 'transportOverride'>,
  ) => Promise<RealtimeTransportKind>;
  isPlaying: boolean;
  start: (options?: string | AudioMonitorStartOptions) => Promise<RealtimeTransportKind>;
  stop: () => void;
  stats: MonitorStatsData | null;
  setVolume: (db: number) => void;
  codec: 'webrtc' | 'pcm/ws';
  transportKind: RealtimeTransportKind | null;
}

export function resolveExistingMonitorStart(
  isPlaying: boolean,
  transportKind: RealtimeTransportKind | null,
  isInitializing: boolean,
  startPromise: Promise<RealtimeTransportKind> | null,
): RealtimeTransportKind | Promise<RealtimeTransportKind> | null {
  if (isPlaying) {
    if (!transportKind) {
      throw new Error('Realtime playback is already running without an active transport');
    }
    return transportKind;
  }

  if (isInitializing) {
    if (!startPromise) {
      throw new Error('Realtime playback is already initializing');
    }
    return startPromise;
  }

  return null;
}

export function useAudioMonitorPlayback(
  options: UseAudioMonitorPlaybackOptions
): UseAudioMonitorPlaybackReturn {
  const { scope, previewSessionId } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [stats, setStats] = useState<MonitorStatsData | null>(null);
  const [transportKind, setTransportKind] = useState<RealtimeTransportKind | null>(null);
  const isPlayingRef = useRef(false);
  const transportKindRef = useRef<RealtimeTransportKind | null>(null);
  const roomRef = useRef<Room | null>(null);
  const attachedTracksRef = useRef<Map<string, RemoteAudioTrack>>(new Map());
  const attachedElementsRef = useRef<Map<string, HTMLMediaElement>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const compatPlaybackBackendRef = useRef<CompatPlaybackBackend | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compatSocketRef = useRef<WebSocket | null>(null);
  const isInitializingRef = useRef(false);
  const startPromiseRef = useRef<Promise<RealtimeTransportKind> | null>(null);
  const currentVolumeRef = useRef(1);
  const sourceStatsRef = useRef<RealtimeSourceStats | null>(null);
  const receiverStatsRef = useRef<ReceiverStatsData | null>(null);
  const statsPollTimerRef = useRef<number | null>(null);
  const displayLatencyRef = useRef<number | null>(null);
  const displayBufferFillRef = useRef<number | null>(null);
  const activePreviewSessionIdRef = useRef<string | null>(previewSessionId ?? null);
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

  const updateIsPlaying = useCallback((next: boolean) => {
    isPlayingRef.current = next;
    setIsPlaying(next);
  }, []);

  const updateTransportKind = useCallback((next: RealtimeTransportKind | null) => {
    transportKindRef.current = next;
    setTransportKind(next);
  }, []);

  const cleanupTransportState = useCallback((
    options: {
      preserveSessionContext?: boolean;
      preserveAudioContext?: boolean;
    } = {},
  ) => {
    const {
      preserveSessionContext = false,
      preserveAudioContext = false,
    } = options;

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

    if (compatPlaybackBackendRef.current) {
      try {
        compatPlaybackBackendRef.current.close();
      } catch {
        // ignore
      }
      compatPlaybackBackendRef.current = null;
    }

    if (gainNodeRef.current) {
      try {
        gainNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      gainNodeRef.current = null;
    }

    if (!preserveAudioContext && audioContextRef.current) {
      void closeAudioContext(audioContextRef.current);
      audioContextRef.current = null;
    }

    sourceStatsRef.current = null;
    receiverStatsRef.current = null;
    displayLatencyRef.current = null;
    displayBufferFillRef.current = null;
    updateTransportKind(null);
    updateIsPlaying(false);
    setStats(null);

    if (!preserveSessionContext) {
      activePreviewSessionIdRef.current = null;
    }

    isInitializingRef.current = false;
  }, [detachAllTracks, rejectPendingTrackWaiters, updateIsPlaying, updateTransportKind]);

  const cleanup = useCallback(() => {
    cleanupTransportState();
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

        const inbound = entry as InboundRtpStatsLike;
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

  const preparePlaybackFromGesture = useCallback(async () => {
    audioContextRef.current = await ensureInteractiveAudioContext(audioContextRef.current);
  }, []);

  const startLiveKitPlayback = useCallback(async (
    offer: RealtimeTransportOffer,
  ) => {
    const audioContext = await ensureInteractiveAudioContext(audioContextRef.current);
    audioContextRef.current = audioContext;

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
      });

      if (!room.canPlaybackAudio) {
        await room.startAudio();
      }

      attachExistingBridgeTracks(room);
      await waitForPlaybackPath(AUDIO_TRACK_WAIT_TIMEOUT_MS);
      roomRef.current = room;
      updateTransportKind('livekit');
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
  }, [attachBridgeTrackPublication, attachExistingBridgeTracks, cleanup, pollReceiverStats, recomputeStats, resolvePendingTrackWaiters, updateTransportKind, waitForPlaybackPath]);

  const startCompatPlayback = useCallback(async (offer: RealtimeTransportOffer) => {
    const audioContext = await ensureInteractiveAudioContext(audioContextRef.current);
    audioContextRef.current = audioContext;

    const backend = await createCompatPlaybackBackend(audioContext, (backendStats: CompatPlaybackStats) => {
      receiverStatsRef.current = {
        latencyMs: backendStats.latencyMs,
        bufferFillPercent: backendStats.bufferFillPercent,
        droppedSamples: backendStats.droppedSamples,
        queueDurationMs: backendStats.queueDurationMs,
        targetBufferMs: backendStats.targetBufferMs,
      };
      recomputeStats();
    });
    const gainNode = audioContext.createGain();
    gainNode.gain.value = currentVolumeRef.current;
    backend.outputNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    compatPlaybackBackendRef.current = backend;
    gainNodeRef.current = gainNode;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${normalizeWsUrl(offer.url)}?token=${encodeURIComponent(offer.token)}`);
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
        updateTransportKind('ws-compat');
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data) as { type?: string };
            if (message.type === 'ready' && !settled) {
              settled = true;
              window.clearTimeout(timer);
              resolve();
            }
          } catch {
            // ignore non-JSON text frames
          }
          return;
        }

        try {
          const decoded = decodeWsCompatAudioFrame(event.data as ArrayBuffer);
          const float32 = int16ToFloat32Pcm(decoded.pcm);
          backend.handleAudioData({
            buffer: float32.buffer,
            sampleRate: decoded.sampleRate,
            clientTimestamp: decoded.timestampMs,
          });

          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
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

    resolvePendingTrackWaiters();

    if (compatSocketRef.current) {
      const activeSocket = compatSocketRef.current;
      compatSocketRef.current.onclose = () => {
        if (compatSocketRef.current === activeSocket && !intentionalDisconnectRef.current) {
          cleanup();
        }
      };
    }
  }, [recomputeStats, resolvePendingTrackWaiters, updateTransportKind]);

  const start = useCallback(async (startOptions?: string | AudioMonitorStartOptions) => {
    const existingStart = resolveExistingMonitorStart(
      isPlayingRef.current,
      transportKindRef.current,
      isInitializingRef.current,
      startPromiseRef.current,
    );
    if (existingStart) {
      return existingStart;
    }

    const normalizedOptions = typeof startOptions === 'string'
      ? { previewSessionId: startOptions, transportOverride: undefined }
      : (startOptions ?? {});
    const effectivePreviewSessionId = normalizedOptions.previewSessionId ?? previewSessionId ?? undefined;
    const transportOverride = normalizedOptions.transportOverride;

    if (scope === 'openwebrx-preview' && !effectivePreviewSessionId) {
      throw new Error('previewSessionId is required for OpenWebRX preview playback');
    }

    isInitializingRef.current = true;
    intentionalDisconnectRef.current = false;
    activePreviewSessionIdRef.current = effectivePreviewSessionId ?? null;

    startPromiseRef.current = (async () => {
      const result = await executeRealtimeSessionFlow({
        scope,
        direction: 'recv',
        previewSessionId: effectivePreviewSessionId,
        transportOverride,
        connectStage: 'connect',
        startLiveKit: startLiveKitPlayback,
        startCompat: startCompatPlayback,
        cleanupFailedAttempt: async (cleanupOptions) => {
          cleanupTransportState({
            preserveSessionContext: true,
            preserveAudioContext: cleanupOptions?.isFallback ?? false,
          });
          if (intentionalDisconnectRef.current) {
            throw new Error('Realtime playback intentionally interrupted');
          }
        },
      });
      if (result.fallbackUsed) {
        showRealtimeTransportFallbackToast(scope);
      }
      updateTransportKind(result.transport);
      startStatsPolling();
      updateIsPlaying(true);
      return result.transport;
    })();

    try {
      return await startPromiseRef.current;
    } catch (error) {
      intentionalDisconnectRef.current = true;
      cleanup();
      logger.error('Failed to start realtime playback', error);
      throw error;
    } finally {
      isInitializingRef.current = false;
      startPromiseRef.current = null;
    }
  }, [cleanup, cleanupTransportState, previewSessionId, scope, startCompatPlayback, startLiveKitPlayback, startStatsPolling, updateIsPlaying, updateTransportKind]);

  const startFromGesture = useCallback(async (
    startOptions?: string | AudioMonitorStartOptions,
  ): Promise<RealtimeTransportKind> => {
    await preparePlaybackFromGesture();
    return start(startOptions);
  }, [preparePlaybackFromGesture, start]);

  const switchTransportFromGesture = useCallback(async (
    transport: RealtimeTransportKind,
    switchOptions?: Omit<AudioMonitorStartOptions, 'transportOverride'>,
  ): Promise<RealtimeTransportKind> => {
    await preparePlaybackFromGesture();

    if (isInitializingRef.current) {
      throw new Error('Realtime playback is already initializing');
    }

    if (isPlayingRef.current) {
      const activeRoom = roomRef.current;
      const activeCompatSocket = compatSocketRef.current;
      const drainTasks: Promise<void>[] = [];
      if (activeRoom) {
        drainTasks.push(waitForRoomDisconnected(activeRoom));
      }
      if (activeCompatSocket) {
        drainTasks.push(waitForSocketClosed(activeCompatSocket));
      }

      intentionalDisconnectRef.current = true;
      cleanupTransportState({ preserveAudioContext: true });

      if (drainTasks.length > 0) {
        await Promise.allSettled(drainTasks);
      }
    }

    return start({
      previewSessionId: switchOptions?.previewSessionId,
      transportOverride: transport,
    });
  }, [cleanupTransportState, preparePlaybackFromGesture, start]);

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
    preparePlaybackFromGesture,
    startFromGesture,
    switchTransportFromGesture,
    isPlaying,
    start,
    stop,
    stats,
    setVolume,
    codec: transportKind === 'ws-compat' ? 'pcm/ws' : 'webrtc',
    transportKind,
  };
}
