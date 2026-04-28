export type RealtimeClockConfidence = 'unknown' | 'low' | 'medium' | 'high';

export interface RealtimeClockSyncPingMessage {
  type: 'clock-sync';
  id: string;
  clientSentAtMs: number;
}

export interface RealtimeClockSyncPongMessage extends RealtimeClockSyncPingMessage {
  serverReceivedAtMs: number;
  serverSentAtMs: number;
}

export interface RealtimeClockSyncSnapshot {
  offsetMs: number | null;
  rttMs: number | null;
  confidence: RealtimeClockConfidence;
  sampleCount: number;
  updatedAtMs: number | null;
}

interface PendingClockSyncRequest {
  clientSentAtMs: number;
}

interface ClockSyncSample {
  offsetMs: number;
  rttMs: number;
  updatedAtMs: number;
}

const TIMESTAMP_32_WRAP_MS = 0x1_0000_0000;
const MAX_CLOCK_SYNC_SAMPLES = 8;

export function unwrapServerTimestamp32Ms(wrappedTimestampMs: number, referenceServerTimeMs: number): number {
  const wrapped = ((wrappedTimestampMs % TIMESTAMP_32_WRAP_MS) + TIMESTAMP_32_WRAP_MS) % TIMESTAMP_32_WRAP_MS;
  const referenceBase = Math.floor(referenceServerTimeMs / TIMESTAMP_32_WRAP_MS) * TIMESTAMP_32_WRAP_MS;
  const candidates = [
    referenceBase + wrapped - TIMESTAMP_32_WRAP_MS,
    referenceBase + wrapped,
    referenceBase + wrapped + TIMESTAMP_32_WRAP_MS,
  ];

  return candidates.reduce((best, candidate) => (
    Math.abs(candidate - referenceServerTimeMs) < Math.abs(best - referenceServerTimeMs)
      ? candidate
      : best
  ));
}

export class RealtimeClockSync {
  private sequence = 0;
  private readonly pending = new Map<string, PendingClockSyncRequest>();
  private samples: ClockSyncSample[] = [];

  createPing(clientSentAtMs = Date.now()): RealtimeClockSyncPingMessage {
    const id = `${clientSentAtMs.toString(36)}-${(this.sequence++).toString(36)}`;
    this.pending.set(id, { clientSentAtMs });
    return {
      type: 'clock-sync',
      id,
      clientSentAtMs,
    };
  }

  handlePong(message: unknown, clientReceivedAtMs = Date.now()): boolean {
    if (!isClockSyncPongMessage(message)) {
      return false;
    }

    const pending = this.pending.get(message.id);
    const clientSentAtMs = pending?.clientSentAtMs ?? message.clientSentAtMs;
    this.pending.delete(message.id);

    const serverReceivedAtMs = Number(message.serverReceivedAtMs);
    const serverSentAtMs = Number(message.serverSentAtMs);
    const serverProcessingMs = Math.max(0, serverSentAtMs - serverReceivedAtMs);
    const rttMs = Math.max(0, (clientReceivedAtMs - clientSentAtMs) - serverProcessingMs);
    const offsetMs = ((serverReceivedAtMs - clientSentAtMs) + (serverSentAtMs - clientReceivedAtMs)) / 2;

    if (!Number.isFinite(rttMs) || !Number.isFinite(offsetMs) || rttMs > 60_000) {
      return false;
    }

    this.samples.push({ offsetMs, rttMs, updatedAtMs: clientReceivedAtMs });
    this.samples = this.samples
      .sort((left, right) => left.rttMs - right.rttMs)
      .slice(0, MAX_CLOCK_SYNC_SAMPLES);
    return true;
  }

  getSnapshot(): RealtimeClockSyncSnapshot {
    const best = this.samples[0];
    if (!best) {
      return {
        offsetMs: null,
        rttMs: null,
        confidence: 'unknown',
        sampleCount: 0,
        updatedAtMs: null,
      };
    }

    return {
      offsetMs: best.offsetMs,
      rttMs: best.rttMs,
      confidence: this.resolveConfidence(best.rttMs),
      sampleCount: this.samples.length,
      updatedAtMs: best.updatedAtMs,
    };
  }

  unwrapServerTimestamp(wrappedTimestampMs: number, clientReferenceTimeMs = Date.now()): number | null {
    const snapshot = this.getSnapshot();
    if (snapshot.offsetMs == null) {
      return null;
    }
    return unwrapServerTimestamp32Ms(wrappedTimestampMs, clientReferenceTimeMs + snapshot.offsetMs);
  }

  reset(): void {
    this.pending.clear();
    this.samples = [];
    this.sequence = 0;
  }

  private resolveConfidence(rttMs: number): RealtimeClockConfidence {
    if (this.samples.length >= 3 && rttMs <= 120) {
      return 'high';
    }
    if (this.samples.length >= 2 && rttMs <= 500) {
      return 'medium';
    }
    return 'low';
  }
}

function isClockSyncPongMessage(message: unknown): message is RealtimeClockSyncPongMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const candidate = message as Partial<RealtimeClockSyncPongMessage>;
  return candidate.type === 'clock-sync'
    && typeof candidate.id === 'string'
    && typeof candidate.clientSentAtMs === 'number'
    && typeof candidate.serverReceivedAtMs === 'number'
    && typeof candidate.serverSentAtMs === 'number';
}
