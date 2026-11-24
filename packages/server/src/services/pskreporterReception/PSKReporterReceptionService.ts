/**
 * PSK Reporter reception feedback.
 *
 * Follows the callsigns that open logbook pages ask for and keeps the reports
 * of other stations hearing them for a rolling window. Nothing is requested
 * while the setting is off or no page follows a callsign:
 * - each newly followed callsign is backfilled once from the official query API
 *   (at most once per five minutes per callsign, as PSK Reporter asks);
 * - new reports then arrive through one MQTT connection to mqtt.pskreporter.info,
 *   subscribed only to the followed callsigns, as its terms of use ask.
 *
 * External I/O goes through {@link PSKReporterReceptionTransport}.
 */

import { EventEmitter } from 'eventemitter3';
import type { PSKReporterReceptionSpot, PSKReporterReceptionState } from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger.js';
import { buildReceptionTopic, normalizeReceptionCallsign } from './receptionDecoders.js';

const logger = createLogger('PSKReporterReception');

export const RECEPTION_WINDOW_MS = 30 * 60 * 1000;
export const RECEPTION_HISTORY_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const RECEPTION_IDLE_DISCONNECT_MS = 60 * 1000;
export const RECEPTION_RECONNECT_BASE_MS = 5 * 1000;
export const RECEPTION_RECONNECT_MAX_MS = 2 * 60 * 1000;
export const RECEPTION_APPEND_FLUSH_MS = 500;
const RECEPTION_HISTORY_TIMEOUT_MS = 20 * 1000;
const MAX_SPOTS_PER_CALLSIGN = 2000;
const CALLSIGN_PATTERN = /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/;

export interface ReceptionLiveHandlers {
  onConnect(): void;
  onMessage(topic: string, payload: Buffer): void;
  /** The connection ended or could not be made. Called at most once per client. */
  onClose(error?: Error): void;
}

export interface ReceptionLiveClient {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  /** Ends the connection without calling `onClose`. */
  close(): void;
}

export interface PSKReporterReceptionTransport {
  /** Opens one live connection. It must not reconnect on its own. */
  connectLive(clientId: string, handlers: ReceptionLiveHandlers): ReceptionLiveClient;
  /** Reports of `callsign` being heard in the last `windowSeconds`. */
  fetchHistory(callsign: string, windowSeconds: number, signal: AbortSignal): Promise<PSKReporterReceptionSpot[]>;
  /** Decodes a live message; `null` drops it. */
  decodeLive(payload: Buffer): PSKReporterReceptionSpot | null;
}

export interface PSKReporterReceptionServiceOptions {
  transport: PSKReporterReceptionTransport;
  isEnabled: () => boolean;
  now?: () => number;
  /** Random suffix for the MQTT client id. */
  randomSuffix?: () => string;
}

interface PSKReporterReceptionEvents {
  /** New spots, possibly for several followed callsigns. */
  spots: (spots: PSKReporterReceptionSpot[]) => void;
  /** The feed state changed, or stored spots were cleared. */
  stateChanged: (state: PSKReporterReceptionState) => void;
}

/** A logbook connection's interest in a set of callsigns. */
export interface ReceptionFollow {
  readonly callsigns: readonly string[];
  update(callsigns: Iterable<string>): void;
  release(): void;
}

export function normalizeFollowedCallsigns(callsigns: Iterable<string>): string[] {
  const result = new Set<string>();
  for (const callsign of callsigns) {
    const normalized = normalizeReceptionCallsign(callsign ?? '');
    if (normalized && CALLSIGN_PATTERN.test(normalized)) {
      result.add(normalized);
    }
  }
  return Array.from(result).sort();
}

export class PSKReporterReceptionService extends EventEmitter<PSKReporterReceptionEvents> {
  private readonly transport: PSKReporterReceptionTransport;
  private readonly isEnabled: () => boolean;
  private readonly now: () => number;
  private readonly clientIdSuffix: string;

  private readonly demand = new Map<string, number>();
  /** Callsigns desired at the last reconcile; a newly desired one is backfilled. */
  private readonly previouslyDesired = new Set<string>();
  private readonly spotsByCallsign = new Map<string, Map<string, PSKReporterReceptionSpot>>();
  private readonly lastHistoryRequestAt = new Map<string, number>();
  private readonly historyRequests = new Map<string, AbortController>();
  /** Gap backfills waiting for the query interval after a reconnect. */
  private readonly deferredHistory = new Map<string, NodeJS.Timeout>();

  private client: ReceptionLiveClient | null = null;
  private connected = false;
  private readonly subscribed = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private pendingAppend: PSKReporterReceptionSpot[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** Last emitted state; unset until the first emit so construction reads no settings. */
  private lastState: PSKReporterReceptionState | null = null;
  private stopped = false;

  constructor(options: PSKReporterReceptionServiceOptions) {
    super();
    this.transport = options.transport;
    this.isEnabled = options.isEnabled;
    this.now = options.now ?? Date.now;
    this.clientIdSuffix = (options.randomSuffix ?? (() => Math.random().toString(16).slice(2, 10)))();
  }

  get windowMs(): number {
    return RECEPTION_WINDOW_MS;
  }

  getState(): PSKReporterReceptionState {
    return this.computeState();
  }

  follow(callsigns: Iterable<string>): ReceptionFollow {
    let current: string[] = [];
    let released = false;
    const follow: ReceptionFollow = {
      get callsigns() {
        return current;
      },
      update: (next) => {
        if (released) return;
        const normalized = normalizeFollowedCallsigns(next);
        if (normalized.join(',') === current.join(',')) return;
        normalized.forEach(callsign => this.demand.set(callsign, (this.demand.get(callsign) ?? 0) + 1));
        current.forEach(callsign => this.decrementDemand(callsign));
        current = normalized;
        this.reconcile();
      },
      release: () => {
        if (released) return;
        released = true;
        current.forEach(callsign => this.decrementDemand(callsign));
        current = [];
        this.reconcile();
      },
    };
    follow.update(callsigns);
    return follow;
  }

  /** Stored spots of the given callsigns inside the window, oldest transmission first. */
  getSpots(callsigns: readonly string[]): PSKReporterReceptionSpot[] {
    if (!this.isEnabled()) return [];
    this.pruneExpired();
    const result: PSKReporterReceptionSpot[] = [];
    for (const callsign of callsigns) {
      const stored = this.spotsByCallsign.get(callsign);
      if (stored) result.push(...stored.values());
    }
    return result.sort((left, right) => left.transmittedAt - right.transmittedAt);
  }

  /** Re-read the enabled setting. Disabling drops the connection and stored spots. */
  onConfigChanged(): void {
    if (!this.isEnabled()) {
      this.spotsByCallsign.clear();
      this.pendingAppend = [];
      this.lastHistoryRequestAt.clear();
    }
    this.reconcile();
    this.emitState(true);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer('reconnectTimer');
    this.clearTimer('idleTimer');
    this.clearTimer('flushTimer');
    this.historyRequests.forEach(controller => controller.abort());
    this.historyRequests.clear();
    this.deferredHistory.forEach(timer => clearTimeout(timer));
    this.deferredHistory.clear();
    this.closeClient();
    this.removeAllListeners();
  }

  private decrementDemand(callsign: string): void {
    const count = (this.demand.get(callsign) ?? 0) - 1;
    if (count > 0) this.demand.set(callsign, count);
    else this.demand.delete(callsign);
  }

  private desiredCallsigns(): string[] {
    return this.isEnabled() && !this.stopped ? Array.from(this.demand.keys()) : [];
  }

  private reconcile(): void {
    if (this.stopped) return;
    const desired = this.desiredCallsigns();
    const newlyDesired = desired.filter(callsign => !this.previouslyDesired.has(callsign));
    this.previouslyDesired.clear();
    desired.forEach(callsign => this.previouslyDesired.add(callsign));

    if (desired.length === 0) {
      this.clearTimer('reconnectTimer');
      this.reconnectAttempts = 0;
      this.historyRequests.forEach(controller => controller.abort());
      this.historyRequests.clear();
      this.deferredHistory.forEach(timer => clearTimeout(timer));
      this.deferredHistory.clear();
      if (!this.isEnabled()) {
        this.clearTimer('idleTimer');
        this.closeClient();
      } else if (this.client) {
        this.syncSubscriptions([]);
        // Keep the connection briefly so a page reload does not reconnect.
        if (!this.idleTimer) {
          this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.desiredCallsigns().length === 0) {
              logger.info('No logbook page follows a callsign; closing the live feed');
              this.closeClient();
              this.emitState();
            }
          }, RECEPTION_IDLE_DISCONNECT_MS);
        }
      }
      this.emitState();
      return;
    }

    this.clearTimer('idleTimer');
    for (const callsign of newlyDesired) {
      this.requestHistory(callsign);
    }
    if (!this.client && !this.reconnectTimer) {
      this.openClient();
    } else if (this.connected) {
      this.syncSubscriptions(desired);
    }
    this.emitState();
  }

  private openClient(): void {
    const desired = this.desiredCallsigns();
    const label = (desired[0] ?? 'station').replace(/[^A-Z0-9]/g, '');
    const clientId = `tx5dr-${label}-${this.clientIdSuffix}`;
    logger.info('Connecting to the PSK Reporter live feed', { callsigns: desired });
    this.connected = false;
    this.subscribed.clear();
    let client: ReceptionLiveClient | null = null;
    const isCurrent = () => client !== null && this.client === client;
    client = this.transport.connectLive(clientId, {
      onConnect: () => {
        if (!isCurrent()) return;
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.info('PSK Reporter live feed connected');
        this.syncSubscriptions(this.desiredCallsigns());
        this.emitState();
      },
      onMessage: (_topic, payload) => {
        if (!isCurrent()) return;
        const spot = this.transport.decodeLive(payload);
        if (spot) this.ingest([spot]);
      },
      onClose: (error) => {
        if (!isCurrent()) return;
        this.client = null;
        this.connected = false;
        this.subscribed.clear();
        if (this.stopped) return;
        if (this.desiredCallsigns().length === 0) {
          this.emitState();
          return;
        }
        const delay = Math.min(
          RECEPTION_RECONNECT_MAX_MS,
          RECEPTION_RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
        );
        this.reconnectAttempts += 1;
        // A feed that stays unreachable (blocked network) retries all day;
        // report the first failures and then every tenth.
        const log = this.reconnectAttempts <= 2 || this.reconnectAttempts % 10 === 0 ? logger.warn : logger.debug;
        log.call(logger, 'PSK Reporter live feed closed; reconnecting later', {
          delayMs: delay,
          attempt: this.reconnectAttempts,
          error: error?.message,
        });
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.desiredCallsigns().length === 0) {
            this.emitState();
            return;
          }
          // Reports sent while disconnected are only reachable through the query;
          // inside the query interval it runs as soon as the interval allows.
          this.desiredCallsigns().forEach(callsign => this.requestHistory(callsign, { deferIfLimited: true }));
          this.openClient();
          this.emitState();
        }, delay);
        this.emitState();
      },
    });
    this.client = client;
  }

  private closeClient(): void {
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.subscribed.clear();
    if (client) {
      try {
        client.close();
      } catch (error) {
        logger.debug('Closing the live feed failed', error);
      }
    }
  }

  private syncSubscriptions(desired: string[]): void {
    const client = this.client;
    if (!client || !this.connected) return;
    const wanted = new Set(desired);
    for (const callsign of Array.from(this.subscribed)) {
      if (!wanted.has(callsign)) {
        client.unsubscribe(buildReceptionTopic(callsign));
        this.subscribed.delete(callsign);
      }
    }
    for (const callsign of wanted) {
      if (!this.subscribed.has(callsign)) {
        client.subscribe(buildReceptionTopic(callsign));
        this.subscribed.add(callsign);
      }
    }
  }

  private requestHistory(callsign: string, options: { deferIfLimited?: boolean } = {}): void {
    if (this.historyRequests.has(callsign) || this.deferredHistory.has(callsign)) return;
    const now = this.now();
    const last = this.lastHistoryRequestAt.get(callsign);
    if (last !== undefined && now - last < RECEPTION_HISTORY_MIN_INTERVAL_MS) {
      if (options.deferIfLimited) {
        const timer = setTimeout(() => {
          this.deferredHistory.delete(callsign);
          if (this.desiredCallsigns().includes(callsign)) {
            this.requestHistory(callsign);
          }
        }, last + RECEPTION_HISTORY_MIN_INTERVAL_MS - now);
        this.deferredHistory.set(callsign, timer);
      }
      return;
    }
    this.lastHistoryRequestAt.set(callsign, now);

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RECEPTION_HISTORY_TIMEOUT_MS);
    this.historyRequests.set(callsign, controller);
    this.transport.fetchHistory(callsign, Math.round(RECEPTION_WINDOW_MS / 1000), controller.signal)
      .then((spots) => {
        if (controller.signal.aborted || !this.demand.has(callsign) || !this.isEnabled()) return;
        const own = spots.filter(spot => spot.senderCallsign === callsign);
        logger.info('PSK Reporter history loaded', { callsign, count: own.length });
        this.ingest(own);
      })
      .catch((error: unknown) => {
        // Cancelled because no page follows the callsign any more.
        if (controller.signal.aborted && !timedOut) return;
        logger.warn('PSK Reporter history query failed', {
          callsign,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.historyRequests.get(callsign) === controller) {
          this.historyRequests.delete(callsign);
        }
      });
  }

  private ingest(spots: PSKReporterReceptionSpot[]): void {
    if (this.stopped || !this.isEnabled()) return;
    const oldest = this.now() - RECEPTION_WINDOW_MS;
    for (const spot of spots) {
      const sender = spot.senderCallsign;
      if (!this.demand.has(sender) || spot.receiverCallsign === sender || spot.transmittedAt < oldest) {
        continue;
      }
      let stored = this.spotsByCallsign.get(sender);
      if (!stored) {
        stored = new Map();
        this.spotsByCallsign.set(sender, stored);
      }
      if (stored.has(spot.id)) continue;
      stored.set(spot.id, spot);
      this.pendingAppend.push(spot);
      if (stored.size > MAX_SPOTS_PER_CALLSIGN) {
        const oldestSpot = Array.from(stored.values()).reduce((left, right) => (
          right.transmittedAt < left.transmittedAt ? right : left
        ));
        stored.delete(oldestSpot.id);
      }
    }
    if (this.pendingAppend.length > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushAppend(), RECEPTION_APPEND_FLUSH_MS);
    }
  }

  private flushAppend(): void {
    this.flushTimer = null;
    const spots = this.pendingAppend;
    this.pendingAppend = [];
    if (spots.length > 0 && !this.stopped) {
      this.emit('spots', spots);
    }
  }

  private pruneExpired(): void {
    const oldest = this.now() - RECEPTION_WINDOW_MS;
    for (const [callsign, stored] of this.spotsByCallsign) {
      for (const [id, spot] of stored) {
        if (spot.transmittedAt < oldest) stored.delete(id);
      }
      if (stored.size === 0) this.spotsByCallsign.delete(callsign);
    }
  }

  private computeState(): PSKReporterReceptionState {
    if (!this.isEnabled()) return 'disabled';
    if (this.desiredCallsigns().length === 0) return 'idle';
    if (this.connected) return 'live';
    if (this.reconnectTimer) return 'reconnecting';
    return 'connecting';
  }

  private emitState(force = false): void {
    if (this.stopped) return;
    const state = this.computeState();
    if (!force && state === this.lastState) return;
    this.lastState = state;
    this.emit('stateChanged', state);
  }

  private clearTimer(key: 'reconnectTimer' | 'idleTimer' | 'flushTimer'): void {
    const timer = this[key];
    if (timer) {
      clearTimeout(timer);
      this[key] = null;
    }
  }
}
