import { api } from '@tx5dr/core';
import type {
  RealtimeConnectivityHints,
  RealtimeScope,
  RealtimeSessionDirection,
  RealtimeTransportKind,
  RealtimeTransportOffer,
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
  connectStage: 'connect' | 'publish' | 'subscribe';
  startLiveKit: (offer: RealtimeTransportOffer) => Promise<void>;
  startCompat: (offer: RealtimeTransportOffer) => Promise<void>;
  cleanupFailedAttempt: (options?: CleanupFailedAttemptOptions) => Promise<void> | void;
}

export interface ExecuteRealtimeSessionFlowResult {
  connectivityHints?: RealtimeConnectivityHints;
  transport: RealtimeTransportKind;
  /** true if primary transport failed and a fallback transport was used */
  fallbackUsed?: boolean;
}

async function startOffer(
  offer: RealtimeTransportOffer,
  options: ExecuteRealtimeSessionFlowOptions,
): Promise<void> {
  if (offer.transport === 'livekit') {
    await options.startLiveKit(offer);
  } else {
    await options.startCompat(offer);
  }
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
    });

    connectivityHints = options.transportOverride === 'ws-compat'
      ? undefined
      : session.connectivityHints;
    effectiveTransportPolicy = session.effectiveTransportPolicy;
    selectionReason = session.selectionReason;

    const primaryOffer = session.offers[0];
    if (!primaryOffer) {
      throw new Error('No realtime transport offer is available');
    }

    const fallbackOffer = session.offers[1] ?? null;
    selectedTransport = primaryOffer.transport;
    errorStage = options.connectStage;

    try {
      await startOffer(primaryOffer, options);
      return {
        connectivityHints,
        transport: primaryOffer.transport,
      };
    } catch (primaryError) {
      // No fallback available — re-throw immediately
      if (!fallbackOffer) {
        throw primaryError;
      }

      // Cleanup primary attempt, preserving AudioContext for fallback
      logger.warn('Primary transport failed, falling back', {
        scope: options.scope,
        direction: options.direction,
        primary: primaryOffer.transport,
        fallback: fallbackOffer.transport,
        primaryError,
      });
      try {
        await options.cleanupFailedAttempt({ isFallback: true });
      } catch (cleanupError) {
        logger.warn('Cleanup before fallback also failed', { cleanupError });
      }

      // Try fallback offer
      selectedTransport = fallbackOffer.transport;
      try {
        await startOffer(fallbackOffer, options);
        return {
          connectivityHints,
          transport: fallbackOffer.transport,
          fallbackUsed: true,
        };
      } catch (fallbackError) {
        // Both transports failed — throw the fallback error (more relevant to user)
        logger.error('Fallback transport also failed', {
          scope: options.scope,
          direction: options.direction,
          primary: primaryOffer.transport,
          fallback: fallbackOffer.transport,
          fallbackError,
        });
        throw fallbackError;
      }
    }
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
