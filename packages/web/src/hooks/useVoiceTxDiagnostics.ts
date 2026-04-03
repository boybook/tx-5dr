import { useEffect, useMemo, useState } from 'react';
import { api } from '@tx5dr/core';
import type {
  RealtimeVoiceTxBottleneckStage,
  RealtimeVoiceTxStatsResponse,
  RealtimeTransportKind,
} from '@tx5dr/contracts';
import type { VoiceCaptureController } from './useVoiceCaptureController';
import type { VoiceTxLocalDiagnostics } from '../audio/voiceTxDiagnostics';
import { createLogger } from '../utils/logger';

const logger = createLogger('useVoiceTxDiagnostics');
const ACTIVE_POLL_INTERVAL_MS = 250;
const IDLE_POLL_INTERVAL_MS = 1000;

export interface VoiceTxDiagnosticsData extends RealtimeVoiceTxStatsResponse {
  client: VoiceTxLocalDiagnostics | null;
  display: {
    transportLatencyMs: number | null;
    totalLatencyMs: number | null;
    totalLatencyKind: 'measured' | 'estimated' | 'partial' | 'unavailable';
    bottleneckStage: RealtimeVoiceTxBottleneckStage | null;
    transport: RealtimeTransportKind | null;
  };
}

function pickBottleneckStage(
  client: VoiceTxLocalDiagnostics | null,
  server: RealtimeVoiceTxStatsResponse | null,
): RealtimeVoiceTxBottleneckStage | null {
  const candidates: Array<{ stage: RealtimeVoiceTxBottleneckStage; value: number }> = [
    {
      stage: 'client-capture',
      value: client?.encodeAndSendMs.rolling ?? 0,
    },
    {
      stage: 'transport',
      value: server?.transport.clientToServerMs.rolling ?? 0,
    },
    {
      stage: 'server-ingress',
      value: server?.serverIngress.frameIntervalMs.rolling ?? 0,
    },
    {
      stage: 'server-queue',
      value: Math.max(
        server?.serverOutput.queueWaitMs.rolling ?? 0,
        server?.serverIngress.queuedAudioMs ?? 0,
      ),
    },
    {
      stage: 'server-output',
      value: Math.max(
        server?.serverOutput.resampleMs.rolling ?? 0,
        server?.serverOutput.writeMs.rolling ?? 0,
      ),
    },
  ];

  const winner = candidates.reduce<{ stage: RealtimeVoiceTxBottleneckStage; value: number } | null>((best, current) => {
    if (current.value <= 0) {
      return best;
    }
    if (!best || current.value > best.value) {
      return current;
    }
    return best;
  }, null);

  return winner?.stage ?? server?.summary.bottleneckStage ?? null;
}

export function useVoiceTxDiagnostics(
  voiceCaptureController?: VoiceCaptureController,
  enabled = true,
): VoiceTxDiagnosticsData | null {
  const [serverStats, setServerStats] = useState<RealtimeVoiceTxStatsResponse | null>(null);
  const [clientStats, setClientStats] = useState<VoiceTxLocalDiagnostics | null>(null);

  useEffect(() => {
    if (!enabled) {
      setServerStats(null);
      setClientStats(null);
      return;
    }

    let cancelled = false;

    const tick = async () => {
      const localStats = voiceCaptureController?.getDiagnostics() ?? null;
      if (!cancelled) {
        setClientStats(localStats);
      }

      try {
        const response = await api.getRealtimeVoiceTxStats('radio');
        if (!cancelled) {
          setServerStats(response);
        }
      } catch (error) {
        logger.debug('Failed to poll realtime voice TX stats', error);
      }
    };

    void tick();
    const pollIntervalMs = voiceCaptureController?.isPTTActive
      ? ACTIVE_POLL_INTERVAL_MS
      : IDLE_POLL_INTERVAL_MS;
    const timer = window.setInterval(() => {
      void tick();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, voiceCaptureController, voiceCaptureController?.isPTTActive]);

  return useMemo(() => {
    if (!serverStats && !clientStats) {
      return null;
    }

    const transport = voiceCaptureController?.activeTransport
      ?? clientStats?.transport
      ?? serverStats?.summary.transport
      ?? null;
    const transportLatencyMs = transport === 'ws-compat'
      ? serverStats?.transport.clientToServerMs.rolling ?? null
      : null;
    const bottleneckStage = pickBottleneckStage(clientStats, serverStats);
    const clientStartupMs = clientStats?.pttToFirstSentFrameMs
      ?? clientStats?.pttToTrackUnmuteMs
      ?? null;
    const serverEndToEndMs = serverStats?.serverOutput.endToEndMs.rolling ?? null;
    const livekitOneWayEstimateMs = clientStats?.livekitRoundTripTimeMs != null
      ? clientStats.livekitRoundTripTimeMs / 2
      : null;

    let totalLatencyMs: number | null = null;
    let totalLatencyKind: 'measured' | 'estimated' | 'partial' | 'unavailable' = 'unavailable';

    if (transport === 'ws-compat' && clientStartupMs != null && serverEndToEndMs != null) {
      totalLatencyMs = clientStartupMs + serverEndToEndMs;
      totalLatencyKind = 'measured';
    } else if (transport === 'livekit' && clientStartupMs != null && serverEndToEndMs != null && livekitOneWayEstimateMs != null) {
      totalLatencyMs = clientStartupMs + livekitOneWayEstimateMs + serverEndToEndMs;
      totalLatencyKind = 'estimated';
    } else if (clientStartupMs != null && serverEndToEndMs != null) {
      totalLatencyMs = clientStartupMs + serverEndToEndMs;
      totalLatencyKind = 'partial';
    }

    return {
      scope: serverStats?.scope ?? 'radio',
      summary: {
        active: serverStats?.summary.active ?? Boolean(voiceCaptureController?.isPTTActive),
        transport,
        bottleneckStage,
        startedAt: serverStats?.summary.startedAt ?? null,
        updatedAt: Math.max(
          serverStats?.summary.updatedAt ?? 0,
          clientStats?.updatedAt ?? 0,
        ) || null,
        clientId: serverStats?.summary.clientId ?? null,
        label: serverStats?.summary.label ?? null,
      },
      transport: serverStats?.transport ?? {
        receivedFrames: 0,
        sequenceGaps: 0,
        lastSequence: null,
        clientToServerMs: {
          current: null,
          rolling: null,
          peak: null,
        },
      },
      serverIngress: serverStats?.serverIngress ?? {
        frameIntervalMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        queueDepthFrames: 0,
        queuedAudioMs: 0,
        droppedFrames: 0,
      },
      serverOutput: serverStats?.serverOutput ?? {
        resampleMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        queueWaitMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        writeMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        endToEndMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        outputSampleRate: null,
        outputBufferSize: null,
        writeFailures: 0,
      },
      client: clientStats,
      display: {
        transportLatencyMs,
        totalLatencyMs,
        totalLatencyKind,
        bottleneckStage,
        transport,
      },
    };
  }, [clientStats, serverStats, voiceCaptureController?.activeTransport, voiceCaptureController?.isPTTActive]);
}
