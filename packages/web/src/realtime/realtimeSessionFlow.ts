import { api } from '@tx5dr/core';
import type {
  RealtimeConnectivityHints,
  RealtimeScope,
  RealtimeSessionDirection,
  RealtimeTransportKind,
  RealtimeTransportOffer,
  type ResolvedVoiceTxBufferPolicy,
  type VoiceTxBufferPreference,
} from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';
import {
  toRealtimeConnectivityError,
} from './realtimeConnectivity';

const logger = createLogger('realtimeSessionFlow');

interface CleanupFailedAttemptOptions {
  /** true when cleaning up before a fallback attempt (preserve AudioContext, etc.) */
  isFallback?: boolean;
}

interface ExecuteRealtimeSessionFlowOptions {
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  previewSessionId?: string;
  transportOverride?: RealtimeTransportKind;
  voiceTxBufferPreference?: VoiceTxBufferPreference;
  connectStage: 'connect' | 'publish' | 'subscribe';
  startCompat: (offer: RealtimeTransportOffer, txBufferPolicy?: ResolvedVoiceTxBufferPolicy) => Promise<void>;
  startRtcDataAudio: (
    offer: RealtimeTransportOffer,
    hints?: RealtimeConnectivityHints,
    txBufferPolicy?: ResolvedVoiceTxBufferPolicy,
  ) => Promise<void>;
  cleanupFailedAttempt: (options?: CleanupFailedAttemptOptions) => Promise<void> | void;
}

export interface ExecuteRealtimeSessionFlowResult {
  connectivityHints?: RealtimeConnectivityHints;
  transport: RealtimeTransportKind;
  voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy;
  /** true if primary transport failed and a fallback transport was used */
  fallbackUsed?: boolean;
}

async function startOffer(
  offer: RealtimeTransportOffer,
  options: ExecuteRealtimeSessionFlowOptions,
  hints?: RealtimeConnectivityHints,
  txBufferPolicy?: ResolvedVoiceTxBufferPolicy,
): Promise<void> {
  if (offer.transport === 'rtc-data-audio') {
    await options.startRtcDataAudio(offer, hints, txBufferPolicy);
    return;
  }
  await options.startCompat(offer, txBufferPolicy);
}

export async function executeRealtimeSessionFlow(
  options: ExecuteRealtimeSessionFlowOptions,
): Promise<ExecuteRealtimeSessionFlowResult> {
  let errorStage: 'token' | 'connect' | 'publish' | 'subscribe' = 'token';
  let connectivityHints: RealtimeConnectivityHints | undefined;
  let selectedTransport: RealtimeTransportKind | null = null;
  let effectiveTransportPolicy: 'auto' | 'force-compat' | undefined;
  let selectionReason: string | undefined;

  try {
    const session = await api.getRealtimeSession({
      scope: options.scope,
      direction: options.direction,
      ...(options.previewSessionId ? { previewSessionId: options.previewSessionId } : {}),
      ...(options.transportOverride ? { transportOverride: options.transportOverride } : {}),
      ...(options.voiceTxBufferPreference ? { voiceTxBufferPreference: options.voiceTxBufferPreference } : {}),
    });

    connectivityHints = options.transportOverride === 'ws-compat'
      ? undefined
      : session.connectivityHints;
    effectiveTransportPolicy = session.effectiveTransportPolicy;
    selectionReason = session.selectionReason;

    const offers = session.offers;
    const primaryOffer = offers[0];
    if (!primaryOffer) {
      throw new Error('No realtime transport offer is available');
    }

    let lastError: unknown = null;
    for (let index = 0; index < offers.length; index += 1) {
      const offer = offers[index]!;
      selectedTransport = offer.transport;
      errorStage = options.connectStage;
      try {
        await startOffer(offer, options, connectivityHints, session.voiceTxBufferPolicy);
        return {
          connectivityHints,
          transport: offer.transport,
          ...(session.voiceTxBufferPolicy ? { voiceTxBufferPolicy: session.voiceTxBufferPolicy } : {}),
          fallbackUsed: index > 0,
        };
      } catch (attemptError) {
        lastError = attemptError;
        const nextOffer = offers[index + 1];
        if (!nextOffer) {
          break;
        }
        logger.warn('Realtime transport failed, trying next offer', {
          scope: options.scope,
          direction: options.direction,
          failed: offer.transport,
          next: nextOffer.transport,
          attemptError,
        });
        try {
          await options.cleanupFailedAttempt({ isFallback: true });
        } catch (cleanupError) {
          logger.warn('Cleanup before fallback also failed', { cleanupError });
        }
      }
    }

    throw lastError ?? new Error('All realtime transport offers failed');
  } catch (error) {
    if (selectedTransport) {
      logger.warn('Realtime transport start failed', {
        scope: options.scope,
        direction: options.direction,
        transport: selectedTransport,
        effectiveTransportPolicy,
        selectionReason,
        error,
      });
      try {
        await options.cleanupFailedAttempt({ isFallback: false });
      } catch (cleanupError) {
        logger.warn('Realtime transport cleanup after failure also failed', {
          scope: options.scope,
          direction: options.direction,
          transport: selectedTransport,
          cleanupError,
        });
      }
    }

    const realtimeError = toRealtimeConnectivityError(error, {
      scope: options.scope,
      stage: errorStage,
      hints: connectivityHints,
    });
    if (!realtimeError.issue.context) {
      realtimeError.issue.context = {};
    }
    if (selectedTransport) {
      realtimeError.issue.context.selectedTransport = selectedTransport;
    }
    if (options.transportOverride) {
      realtimeError.issue.context.transportOverride = options.transportOverride;
    }
    if (effectiveTransportPolicy) {
      realtimeError.issue.context.effectiveTransportPolicy = effectiveTransportPolicy;
    }
    if (selectionReason) {
      realtimeError.issue.context.selectionReason = selectionReason;
    }
    throw realtimeError;
  }
}
