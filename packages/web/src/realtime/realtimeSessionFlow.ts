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

interface ExecuteRealtimeSessionFlowOptions {
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  previewSessionId?: string;
  transportOverride?: RealtimeTransportKind;
  connectStage: 'connect' | 'publish' | 'subscribe';
  startLiveKit: (offer: RealtimeTransportOffer) => Promise<void>;
  startCompat: (offer: RealtimeTransportOffer) => Promise<void>;
  cleanupFailedAttempt: () => Promise<void> | void;
}

export interface ExecuteRealtimeSessionFlowResult {
  connectivityHints?: RealtimeConnectivityHints;
  transport: RealtimeTransportKind;
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

    const offer = session.offers[0];
    if (!offer) {
      throw new Error('No realtime transport offer is available');
    }

    selectedTransport = offer.transport;

    errorStage = options.connectStage;
    if (offer.transport === 'livekit') {
      await options.startLiveKit(offer);
    } else {
      await options.startCompat(offer);
    }

    return {
      connectivityHints,
      transport: offer.transport,
    };
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
        await options.cleanupFailedAttempt();
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
