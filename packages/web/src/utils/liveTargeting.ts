import type {
  LogbookSelectTargetCommand,
  LogbookSelectTargetResult,
  LogbookSelectedFrame,
  OperatorStatus,
} from '@tx5dr/contracts';
import type { LiveStation } from './liveDecodes';

/**
 * Picking a heard station on the logbook globe as an operator's QSO target.
 * The page sends the decoded frame; the server answers it the way the
 * operator's strategy takes targets (see OperatorTargetCommandService).
 */

/** How long a selection may wait for the server before the page gives up. */
export const TARGET_REQUEST_TIMEOUT_MS = 8000;

export interface TargetOperatorOption {
  id: string;
  label: string;
}

/**
 * Operators the page may call with: those its connection shows. The page's
 * own operator comes first when it has one; a single operator is chosen
 * without asking; otherwise the user picks.
 */
export function resolveTargetOperators(
  operators: readonly OperatorStatus[],
  preferredOperatorId?: string,
): { options: TargetOperatorOption[]; defaultId?: string } {
  const options = operators.map(operator => ({
    id: operator.id,
    label: operator.context?.myCall?.trim() || operator.id,
  }));
  const preferred = preferredOperatorId && options.some(option => option.id === preferredOperatorId)
    ? preferredOperatorId
    : undefined;
  return { options, defaultId: preferred ?? (options.length === 1 ? options[0].id : undefined) };
}

export function buildSelectedFrame(station: LiveStation): LogbookSelectedFrame {
  return {
    message: station.decode.message,
    snr: station.decode.snr,
    dt: station.decode.dt,
    freq: station.decode.freq,
    slotStartMs: station.slotStartMs,
  };
}

/** Matches selection results to their requests; unanswered requests time out. */
export class TargetRequestTracker {
  private pending = new Map<string, { resolve: (result: LogbookSelectTargetResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private counter = 0;

  request(
    command: Omit<LogbookSelectTargetCommand, 'requestId'>,
    send: (command: LogbookSelectTargetCommand) => void,
  ): Promise<LogbookSelectTargetResult> {
    this.counter += 1;
    const requestId = `target-${Date.now().toString(36)}-${this.counter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(requestId, {
          requestId,
          operatorId: command.operatorId,
          callsign: command.callsign,
          status: 'rejected',
          reason: 'timeout',
          userMessageKey: 'logbook:globe.callTimeout',
        });
      }, TARGET_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      try {
        send({ ...command, requestId });
      } catch {
        this.settle(requestId, {
          requestId,
          operatorId: command.operatorId,
          callsign: command.callsign,
          status: 'rejected',
          reason: 'disconnected',
          userMessageKey: 'logbook:globe.callDisconnected',
        });
      }
    });
  }

  /** A result from the server; results of unknown or settled requests are ignored. */
  resolve(result: LogbookSelectTargetResult): void {
    this.settle(result.requestId, result);
  }

  /** The connection is gone: every waiting request fails now instead of timing out. */
  failAll(): void {
    for (const [requestId, entry] of Array.from(this.pending)) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.resolve({
        requestId,
        operatorId: '',
        callsign: '',
        status: 'rejected',
        reason: 'disconnected',
        userMessageKey: 'logbook:globe.callDisconnected',
      });
    }
  }

  private settle(requestId: string, result: LogbookSelectTargetResult): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(result);
  }
}
