import { useRef, useState, useCallback, useEffect } from 'react';
import { api } from '@tx5dr/core';
import { decodeRealtimePcmAudioFrame, int16ToFloat32Pcm } from '@tx5dr/core';
import type {
  RealtimeConnectivityHints,
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
import { RtcDataAudioClient } from '../realtime/RtcDataAudioClient';
import {
  RealtimeClockSync,
  type RealtimeClockConfidence,
} from '../realtime/RealtimeClockSync';

const logger = createLogger('useAudioMonitorPlayback');
const STATS_POLL_INTERVAL_MS = 1000;
const CLOCK_SYNC_INTERVAL_MS = 1000;
const AUDIO_PATH_WAIT_TIMEOUT_MS = 5000;
const TRANSPORT_SWITCH_DRAIN_TIMEOUT_MS = 1200;
const VOLUME_RAMP_SECONDS = 0.003;

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
  endToEndLatencyMs?: number | null;
  networkAgeMs?: number | null;
  playbackQueueMs?: number;
  sourceToSendMs?: number | null;
  transportMs?: number | null;
  mainToWorkletMs?: number | null;
  outputDeviceLatencyMs?: number;
  clockRttMs?: number | null;
  clockConfidence?: RealtimeClockConfidence;
  outputSourceTimestampMs?: number | null;
  nextOutputSourceTimestampMs?: number | null;
  statsGeneratedAtMs?: number;
  statsReceivedAtMs?: number;
  underrunCount?: number;
  inputSampleRate?: number;
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

export interface MonitorStatsData {
  latencyMs: number;
  bufferFillPercent: number;
  isActive: boolean;
  endToEndLatencyMs: number | null;
  networkAgeMs: number | null;
  playbackQueueMs: number;
  sourceToSendMs: number | null;
  transportMs: number | null;
  mainToWorkletMs: number | null;
  outputDeviceLatencyMs: number;
  clockRttMs: number | null;
  clockConfidence: RealtimeClockConfidence;
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

function getAudioOutputLatencyMs(audioContext: AudioContext | null): number {
  if (!audioContext) {
    return 0;
  }
  const outputLatency = Number((audioContext as AudioContext & { outputLatency?: number }).outputLatency ?? 0);
  const baseLatency = Number(audioContext.baseLatency ?? 0);
  return Math.max(0, (baseLatency + outputLatency) * 1000);
}

function isClockSyncControlMessage(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && (message as { type?: unknown }).type === 'clock-sync');
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
  const audioContextRef = useRef<AudioContext | null>(null);
  const compatPlaybackBackendRef = useRef<CompatPlaybackBackend | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compatSocketRef = useRef<WebSocket | null>(null);
  const rtcDataAudioClientRef = useRef<RtcDataAudioClient | null>(null);
  const isInitializingRef = useRef(false);
  const startPromiseRef = useRef<Promise<RealtimeTransportKind> | null>(null);
  const currentVolumeRef = useRef(1);
  const sourceStatsRef = useRef<RealtimeSourceStats | null>(null);
  const receiverStatsRef = useRef<ReceiverStatsData | null>(null);
  const statsPollTimerRef = useRef<number | null>(null);
  const clockSyncTimerRef = useRef<number | null>(null);
  const clockSyncRef = useRef(new RealtimeClockSync());
  const displayLatencyRef = useRef<number | null>(null);
  const displayBufferFillRef = useRef<number | null>(null);
  const lastReceivedFrameRef = useRef<{
    sourceTimestampMs: number;
    serverSentAtMs?: number;
    receivedAtClientMs: number;
  } | null>(null);
  const activePreviewSessionIdRef = useRef<string | null>(previewSessionId ?? null);
  const intentionalDisconnectRef = useRef(false);
  const pendingAudioPathWaitersRef = useRef<Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  }>>([]);

  const resolvePendingAudioPathWaiters = useCallback(() => {
    const waiters = pendingAudioPathWaitersRef.current.splice(0);
    waiters.forEach(({ resolve, timer }) => {
      window.clearTimeout(timer);
      resolve();
    });
  }, []);

  const rejectPendingAudioPathWaiters = useCallback((message: string) => {
    const waiters = pendingAudioPathWaitersRef.current.splice(0);
    waiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(new Error(message));
    });
  }, []);

  const waitForPlaybackPath = useCallback(async (timeoutMs = AUDIO_PATH_WAIT_TIMEOUT_MS): Promise<void> => {
    if (compatSocketRef.current || rtcDataAudioClientRef.current) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingAudioPathWaitersRef.current = pendingAudioPathWaitersRef.current.filter((entry) => entry.timer !== timer);
        reject(new Error('No realtime audio path became available before timeout'));
      }, timeoutMs);

      pendingAudioPathWaitersRef.current.push({ resolve, reject, timer });
    });
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
      preserveCompatPlaybackRuntime?: boolean;
    } = {},
  ) => {
    const {
      preserveSessionContext = false,
      preserveAudioContext = false,
      preserveCompatPlaybackRuntime = false,
    } = options;

    if (statsPollTimerRef.current !== null) {
      window.clearInterval(statsPollTimerRef.current);
      statsPollTimerRef.current = null;
    }
    if (clockSyncTimerRef.current !== null) {
      window.clearInterval(clockSyncTimerRef.current);
      clockSyncTimerRef.current = null;
    }

    rejectPendingAudioPathWaiters('Realtime playback stopped before audio path became available');

    if (compatSocketRef.current) {
      try {
        compatSocketRef.current.close();
      } catch {
        // ignore
      }
      compatSocketRef.current = null;
    }

    if (rtcDataAudioClientRef.current) {
      try {
        rtcDataAudioClientRef.current.close();
      } catch {
        // ignore
      }
      rtcDataAudioClientRef.current = null;
    }

    if (compatPlaybackBackendRef.current && !preserveCompatPlaybackRuntime) {
      try {
        compatPlaybackBackendRef.current.close();
      } catch {
        // ignore
      }
      compatPlaybackBackendRef.current = null;
    } else if (compatPlaybackBackendRef.current && preserveCompatPlaybackRuntime) {
      compatPlaybackBackendRef.current.reset();
    }

    if (gainNodeRef.current && !preserveCompatPlaybackRuntime) {
      try {
        gainNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      gainNodeRef.current = null;
    }

    if (!preserveAudioContext && !preserveCompatPlaybackRuntime && audioContextRef.current) {
      void closeAudioContext(audioContextRef.current);
      audioContextRef.current = null;
    }

    sourceStatsRef.current = null;
    receiverStatsRef.current = null;
    lastReceivedFrameRef.current = null;
    clockSyncRef.current.reset();
    displayLatencyRef.current = null;
    displayBufferFillRef.current = null;
    updateTransportKind(null);
    updateIsPlaying(false);
    setStats(null);

    if (!preserveSessionContext) {
      activePreviewSessionIdRef.current = null;
    }

    isInitializingRef.current = false;
  }, [rejectPendingAudioPathWaiters, updateIsPlaying, updateTransportKind]);

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

    const sourceLatencyMs = source?.latencyMs ?? 0;
    const targetBufferMs = receiver?.targetBufferMs ?? 80;
    const playbackQueueMs = Math.max(0, receiver?.playbackQueueMs ?? receiver?.queueDurationMs ?? receiver?.latencyMs ?? 0);
    const effectiveQueueMs = Math.min(playbackQueueMs, targetBufferMs);
    const stableBufferFillPercent = Math.max(
      0,
      Math.min(100, (effectiveQueueMs / Math.max(targetBufferMs, 1)) * 100),
    );
    const outputDeviceLatencyMs = getAudioOutputLatencyMs(audioContextRef.current);
    const clockSnapshot = clockSyncRef.current.getSnapshot();
    const clientNowMs = Date.now();
    let networkAgeMs: number | null = null;
    let sourceToSendMs: number | null = null;
    let transportMs: number | null = null;
    const lastReceivedFrame = lastReceivedFrameRef.current;
    if (clockSnapshot.offsetMs != null && lastReceivedFrame) {
      const sourceTimestampMs = clockSyncRef.current.unwrapServerTimestamp(
        lastReceivedFrame.sourceTimestampMs,
        lastReceivedFrame.receivedAtClientMs,
      );
      if (sourceTimestampMs != null) {
        const browserReceivedAtServerClockMs = lastReceivedFrame.receivedAtClientMs + clockSnapshot.offsetMs;
        networkAgeMs = Math.max(
          0,
          browserReceivedAtServerClockMs - sourceTimestampMs,
        );
        if (typeof lastReceivedFrame.serverSentAtMs === 'number') {
          const serverSentAtMs = clockSyncRef.current.unwrapServerTimestamp(
            lastReceivedFrame.serverSentAtMs,
            lastReceivedFrame.receivedAtClientMs,
          );
          if (serverSentAtMs != null) {
            sourceToSendMs = Math.max(0, serverSentAtMs - sourceTimestampMs);
            transportMs = Math.max(0, browserReceivedAtServerClockMs - serverSentAtMs);
          }
        }
      }
    }

    let estimatedEndToEndLatencyMs: number | null = null;
    const outputSourceTimestampMs = receiver?.outputSourceTimestampMs ?? receiver?.nextOutputSourceTimestampMs ?? null;
    if (
      sourceToSendMs != null
      && transportMs != null
      && receiver?.mainToWorkletMs != null
    ) {
      estimatedEndToEndLatencyMs = Math.max(
        0,
        sourceToSendMs + transportMs + receiver.mainToWorkletMs + playbackQueueMs + outputDeviceLatencyMs,
      );
    } else if (clockSnapshot.offsetMs != null && outputSourceTimestampMs != null) {
      const sourceTimestampMs = clockSyncRef.current.unwrapServerTimestamp(outputSourceTimestampMs, clientNowMs);
      if (sourceTimestampMs != null) {
        const statsAgeMs = receiver?.statsReceivedAtMs
          ? Math.max(0, Math.min(500, clientNowMs - receiver.statsReceivedAtMs))
          : 0;
        const projectedSourceTimestampMs = sourceTimestampMs + statsAgeMs;
        estimatedEndToEndLatencyMs = Math.max(
          0,
          (clientNowMs + clockSnapshot.offsetMs + outputDeviceLatencyMs) - projectedSourceTimestampMs,
        );
      }
    } else if (clockSnapshot.offsetMs != null && networkAgeMs != null) {
      estimatedEndToEndLatencyMs = Math.max(0, networkAgeMs + playbackQueueMs + outputDeviceLatencyMs);
    }

    const alpha = 0.35;

    const latencyMs = estimatedEndToEndLatencyMs == null
      ? null
      : displayLatencyRef.current == null
        ? estimatedEndToEndLatencyMs
        : (displayLatencyRef.current * (1 - alpha)) + (estimatedEndToEndLatencyMs * alpha);
    const bufferFillPercent = displayBufferFillRef.current == null
      ? stableBufferFillPercent
      : (displayBufferFillRef.current * (1 - alpha)) + (stableBufferFillPercent * alpha);

    displayLatencyRef.current = latencyMs;
    displayBufferFillRef.current = bufferFillPercent;

    const isActive = source?.isActive ?? Boolean(compatSocketRef.current || rtcDataAudioClientRef.current);
    const legacyLatencyMs = latencyMs ?? Math.max(0, sourceLatencyMs + playbackQueueMs);
    const receiverWithDerivedStats: ReceiverStatsData | null = receiver
      ? {
          ...receiver,
          latencyMs: legacyLatencyMs,
          bufferFillPercent,
          queueDurationMs: playbackQueueMs,
          playbackQueueMs,
          endToEndLatencyMs: latencyMs,
          networkAgeMs,
          sourceToSendMs,
          transportMs,
          mainToWorkletMs: receiver.mainToWorkletMs ?? null,
          outputDeviceLatencyMs,
          clockRttMs: clockSnapshot.rttMs,
          clockConfidence: clockSnapshot.confidence,
        }
      : null;

    setStats({
      latencyMs: legacyLatencyMs,
      bufferFillPercent,
      isActive,
      endToEndLatencyMs: latencyMs,
      networkAgeMs,
      playbackQueueMs,
      sourceToSendMs,
      transportMs,
      mainToWorkletMs: receiver?.mainToWorkletMs ?? null,
      outputDeviceLatencyMs,
      clockRttMs: clockSnapshot.rttMs,
      clockConfidence: clockSnapshot.confidence,
      source,
      receiver: receiverWithDerivedStats,
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
    recomputeStats();
  }, [recomputeStats]);

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

  const handleClockSyncControlMessage = useCallback((message: unknown) => {
    if (clockSyncRef.current.handlePong(message)) {
      recomputeStats();
    }
  }, [recomputeStats]);

  const startClockSync = useCallback((sendControl: (payload: Record<string, unknown>) => boolean | void) => {
    if (clockSyncTimerRef.current !== null) {
      window.clearInterval(clockSyncTimerRef.current);
      clockSyncTimerRef.current = null;
    }
    clockSyncRef.current.reset();

    const sendPing = () => {
      try {
        sendControl(clockSyncRef.current.createPing(Date.now()));
      } catch (error) {
        logger.debug('Failed to send realtime clock sync ping', error);
      }
    };

    sendPing();
    clockSyncTimerRef.current = window.setInterval(sendPing, CLOCK_SYNC_INTERVAL_MS);
  }, []);

  const ensureCompatPlaybackRuntime = useCallback(async (): Promise<{
    audioContext: AudioContext;
    backend: CompatPlaybackBackend;
  }> => {
    audioContextRef.current = await ensureInteractiveAudioContext(audioContextRef.current);
    const audioContext = audioContextRef.current;
    if (compatPlaybackBackendRef.current && gainNodeRef.current) {
      return { audioContext, backend: compatPlaybackBackendRef.current };
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

    const backend = await createCompatPlaybackBackend(audioContext, (backendStats: CompatPlaybackStats) => {
      const statsReceivedAtMs = Date.now();
      receiverStatsRef.current = {
        latencyMs: backendStats.latencyMs,
        bufferFillPercent: backendStats.bufferFillPercent,
        droppedSamples: backendStats.droppedSamples,
        queueDurationMs: backendStats.queueDurationMs,
        playbackQueueMs: backendStats.queueDurationMs,
        targetBufferMs: backendStats.targetBufferMs,
        outputSourceTimestampMs: backendStats.outputSourceTimestampMs,
        nextOutputSourceTimestampMs: backendStats.nextOutputSourceTimestampMs,
        mainToWorkletMs: backendStats.mainToWorkletMs,
        statsGeneratedAtMs: backendStats.statsGeneratedAtMs,
        statsReceivedAtMs,
        underrunCount: backendStats.underrunCount,
        inputSampleRate: backendStats.inputSampleRate,
      };
      recomputeStats();
    });
    const gainNode = audioContext.createGain();
    gainNode.gain.value = currentVolumeRef.current;
    backend.outputNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    compatPlaybackBackendRef.current = backend;
    gainNodeRef.current = gainNode;
    return { audioContext, backend };
  }, [recomputeStats]);

  const preparePlaybackFromGesture = useCallback(async () => {
    await ensureCompatPlaybackRuntime();
  }, [ensureCompatPlaybackRuntime]);

  const startCompatPlayback = useCallback(async (offer: RealtimeTransportOffer) => {
    const { backend } = await ensureCompatPlaybackRuntime();
    backend.reset();

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
      }, AUDIO_PATH_WAIT_TIMEOUT_MS);

      ws.onopen = () => {
        updateTransportKind('ws-compat');
        startClockSync((payload) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return false;
          }
          ws.send(JSON.stringify(payload));
          return true;
        });
        resolvePendingAudioPathWaiters();
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data) as { type?: string };
            if (isClockSyncControlMessage(message)) {
              handleClockSyncControlMessage(message);
              return;
            }
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
          const decoded = decodeRealtimePcmAudioFrame(event.data as ArrayBuffer);
          const receivedAtClientMs = Date.now();
          const float32 = int16ToFloat32Pcm(decoded.pcm);
          lastReceivedFrameRef.current = {
            sourceTimestampMs: decoded.timestampMs,
            serverSentAtMs: decoded.serverSentAtMs,
            receivedAtClientMs,
          };
          backend.handleAudioData({
            buffer: float32.buffer,
            sampleRate: decoded.sampleRate,
            clientTimestamp: decoded.timestampMs,
            clientReceivedAtMs: receivedAtClientMs,
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

    resolvePendingAudioPathWaiters();

    if (compatSocketRef.current) {
      const activeSocket = compatSocketRef.current;
      compatSocketRef.current.onclose = () => {
        if (compatSocketRef.current === activeSocket && !intentionalDisconnectRef.current) {
          cleanup();
        }
      };
    }
  }, [cleanup, ensureCompatPlaybackRuntime, handleClockSyncControlMessage, resolvePendingAudioPathWaiters, startClockSync, updateTransportKind]);

  const startRtcDataAudioPlayback = useCallback(async (
    offer: RealtimeTransportOffer,
    hints?: RealtimeConnectivityHints,
  ) => {
    const { backend } = await ensureCompatPlaybackRuntime();
    backend.reset();

    const client = new RtcDataAudioClient({
      offer,
      iceServers: hints?.iceServers,
      onBinaryMessage: (payload) => {
        try {
          const decoded = decodeRealtimePcmAudioFrame(payload);
          const receivedAtClientMs = Date.now();
          const float32 = int16ToFloat32Pcm(decoded.pcm);
          lastReceivedFrameRef.current = {
            sourceTimestampMs: decoded.timestampMs,
            serverSentAtMs: decoded.serverSentAtMs,
            receivedAtClientMs,
          };
          backend.handleAudioData({
            buffer: float32.buffer,
            sampleRate: decoded.sampleRate,
            clientTimestamp: decoded.timestampMs,
            clientReceivedAtMs: receivedAtClientMs,
          });
        } catch (error) {
          logger.debug('Failed to decode rtc-data-audio downlink frame', error);
        }
      },
      onControlMessage: handleClockSyncControlMessage,
      onClose: () => {
        if (rtcDataAudioClientRef.current === client && !intentionalDisconnectRef.current) {
          cleanup();
        }
      },
    });
    rtcDataAudioClientRef.current = client;
    resolvePendingAudioPathWaiters();
    await client.connect();
    startClockSync((payload) => client.sendJson(payload));
    updateTransportKind('rtc-data-audio');
  }, [cleanup, ensureCompatPlaybackRuntime, handleClockSyncControlMessage, resolvePendingAudioPathWaiters, startClockSync, updateTransportKind]);

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
        startCompat: startCompatPlayback,
        startRtcDataAudio: startRtcDataAudioPlayback,
        cleanupFailedAttempt: async (cleanupOptions) => {
          cleanupTransportState({
            preserveSessionContext: true,
            preserveAudioContext: cleanupOptions?.isFallback ?? false,
            preserveCompatPlaybackRuntime: cleanupOptions?.isFallback ?? false,
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
      await waitForPlaybackPath(AUDIO_PATH_WAIT_TIMEOUT_MS);
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
  }, [cleanup, cleanupTransportState, previewSessionId, scope, startCompatPlayback, startRtcDataAudioPlayback, startStatsPolling, updateIsPlaying, updateTransportKind, waitForPlaybackPath]);

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
      const activeCompatSocket = compatSocketRef.current;
      const activeRtcDataAudioClient = rtcDataAudioClientRef.current;
      const drainTasks: Promise<void>[] = [];
      if (activeCompatSocket) {
        drainTasks.push(waitForSocketClosed(activeCompatSocket));
      }
      if (activeRtcDataAudioClient) {
        activeRtcDataAudioClient.close();
      }

      intentionalDisconnectRef.current = true;
      cleanupTransportState({
        preserveAudioContext: true,
        preserveCompatPlaybackRuntime: true,
      });

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
    if (gainNodeRef.current) {
      const gainParam = gainNodeRef.current.gain;
      const contextTime = gainNodeRef.current.context.currentTime;
      gainParam.cancelScheduledValues(contextTime);
      gainParam.setTargetAtTime(linear, contextTime, VOLUME_RAMP_SECONDS);
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
    transportKind,
  };
}
