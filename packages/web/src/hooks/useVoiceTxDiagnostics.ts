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
    networkLatencyMs: number | null;
    serverPipelineMs: number | null;
    softwareLatencyMs: number | null;
    softwareLatencyKind: 'measured' | 'estimated' | 'partial' | 'unavailable';
    endToEndLatencyMs: number | null;
    endToEndLatencyKind: 'measured' | 'estimated' | 'partial' | 'unavailable';
    estimatedFinalLatencyMs: number | null;
    estimatedFinalLatencyKind: 'estimated' | 'partial' | 'unavailable';
    startupMs: number | null;
    localBacklogMs: number | null;
    queueLatencyMs: number | null;
    outputBufferedMs: number | null;
    droppedFrames: number;
    underrunCount: number;
    clockReliable: boolean;
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
      value: Math.max(
        client?.encodeAndSendMs.rolling ?? 0,
        client?.sendBufferedAudioMs.rolling ?? 0,
      ),
    },
    {
      stage: 'transport',
      value: server?.transport.clientToServerMs.rolling ?? 0,
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
        server?.serverOutput.outputBufferedMs.rolling ?? 0,
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
    const transportLatencyMs = transport === 'ws-compat' || transport === 'rtc-data-audio'
      ? serverStats?.transport.clientToServerMs.rolling ?? null
      : null;
    const bottleneckStage = pickBottleneckStage(clientStats, serverStats);
    const clientStartupMs = clientStats?.pttToFirstSentFrameMs ?? null;
    const serverEndToEndMs = serverStats?.serverOutput.endToEndMs.rolling ?? null;
    const serverPipelineMs = serverStats?.serverOutput.serverPipelineMs.rolling ?? null;
    const outputBufferedMs = serverStats?.serverOutput.outputBufferedMs.rolling ?? null;
    const clockReliable = transportLatencyMs != null
      && serverEndToEndMs != null
      && (clientStats?.clockConfidence === 'medium' || clientStats?.clockConfidence === 'high');
    const softwareLatencyMs = serverEndToEndMs;
    const softwareLatencyKind: 'measured' | 'estimated' | 'partial' | 'unavailable' =
      serverEndToEndMs == null
        ? 'unavailable'
        : clockReliable
          ? 'measured'
          : 'partial';
    const estimatedFinalLatencyMs = serverEndToEndMs != null && outputBufferedMs != null
      ? serverEndToEndMs + outputBufferedMs
      : null;
    const estimatedFinalLatencyKind: 'estimated' | 'partial' | 'unavailable' =
      estimatedFinalLatencyMs != null
        ? (clockReliable ? 'estimated' : 'partial')
        : serverEndToEndMs != null
          ? 'partial'
          : 'unavailable';
    const endToEndLatencyMs = estimatedFinalLatencyMs ?? serverEndToEndMs;
    const endToEndLatencyKind: 'measured' | 'estimated' | 'partial' | 'unavailable' =
      estimatedFinalLatencyMs != null
        ? (clockReliable ? 'estimated' : 'partial')
        : serverEndToEndMs != null
          ? (clockReliable ? 'measured' : 'partial')
          : 'unavailable';
    const queuedAudioMs = serverStats?.serverIngress.queuedAudioMs ?? null;
    const queueWaitMs = serverStats?.serverOutput.queueWaitMs.rolling ?? null;
    const queueLatencyMs = queuedAudioMs != null || queueWaitMs != null
      ? Math.max(queuedAudioMs ?? 0, queueWaitMs ?? 0)
      : null;
    const droppedFrames = (clientStats?.clientDroppedFrames ?? 0)
      + (serverStats?.serverIngress.droppedFrames ?? 0);
    const underrunCount = serverStats?.serverIngress.underrunCount ?? 0;

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
        staleDroppedFrames: 0,
        underrunCount: 0,
        plcFrames: 0,
        jitterTargetMs: 0,
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
        serverPipelineMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        endToEndMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        outputBufferedMs: {
          current: null,
          rolling: null,
          peak: null,
        },
        outputWriteIntervalMs: {
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
        networkLatencyMs: clockReliable ? transportLatencyMs : null,
        serverPipelineMs,
        softwareLatencyMs,
        softwareLatencyKind,
        endToEndLatencyMs,
        endToEndLatencyKind,
        estimatedFinalLatencyMs,
        estimatedFinalLatencyKind,
        startupMs: clientStartupMs,
        localBacklogMs: clientStats?.sendBufferedAudioMs.rolling ?? null,
        queueLatencyMs,
        outputBufferedMs,
        droppedFrames,
        underrunCount,
        clockReliable,
        bottleneckStage,
        transport,
      },
    };
  }, [clientStats, serverStats, voiceCaptureController?.activeTransport, voiceCaptureController?.isPTTActive]);
}
