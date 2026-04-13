/**
 * Tracks callsign context information (grid, etc.) accumulated from decoded FT8 frames.
 *
 * Maintains an in-memory map of callsign → info, updated from each SlotPack's frames.
 * When a message lacks grid information (e.g. signal_report, rrr, 73), the tracker
 * provides the most recently observed grid for that callsign.
 */
import type { FT8Message, SlotPack } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CallsignContextTracker');

/** Information tracked per callsign, accumulated from decoded frames. */
export interface CallsignInfo {
  /** Most recently observed grid locator (4-char, e.g. "PM95") */
  grid?: string;
  /** Timestamp (ms) when this entry was last updated */
  lastSeenMs: number;
  /** FT8 message type that provided the grid */
  gridSource?: 'cq' | 'call';
}

export interface CallsignContextTrackerOptions {
  /** Time-to-live in milliseconds. Default: 30 minutes */
  ttlMs?: number;
  /** Interval for cleanup sweeps in milliseconds. Default: 5 minutes */
  cleanupIntervalMs?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;        // 30 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class CallsignContextTracker {
  private entries = new Map<string, CallsignInfo>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;

  constructor(options?: CallsignContextTrackerOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    const cleanupIntervalMs = options?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Allow the process to exit even if the timer is still running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Extract callsign + grid info from all frames in a SlotPack and update the tracker.
   *
   * This should be called ONCE per SlotPack, BEFORE per-client analysis begins,
   * to ensure the tracker is populated before any grid lookups.
   */
  updateFromSlotPack(slotPack: SlotPack, parseFT8Message: (message: string) => FT8Message): void {
    const now = Date.now();
    for (const frame of slotPack.frames) {
      try {
        const parsed = parseFT8Message(frame.message);
        this.updateFromParsedMessage(parsed, now);
      } catch {
        // Skip unparseable messages
      }
    }
  }

  /**
   * Update tracker from a pre-parsed FT8 message.
   */
  updateFromParsedMessage(parsed: FT8Message, now?: number): void {
    const timestamp = now ?? Date.now();

    let callsign: string | undefined;
    let grid: string | undefined;
    let gridSource: 'cq' | 'call' | undefined;

    if (parsed.type === 'cq') {
      callsign = parsed.senderCallsign;
      grid = parsed.grid;
      gridSource = 'cq';
    } else if (parsed.type === 'call') {
      callsign = parsed.senderCallsign;
      grid = parsed.grid;
      gridSource = 'call';
    } else if ('senderCallsign' in parsed && typeof parsed.senderCallsign === 'string') {
      callsign = parsed.senderCallsign;
    }

    if (!callsign) return;

    const key = callsign.toUpperCase();
    const existing = this.entries.get(key);

    if (grid && grid.trim().length >= 4) {
      // Update with new grid info
      this.entries.set(key, {
        grid: grid.trim().toUpperCase().slice(0, 4),
        lastSeenMs: timestamp,
        gridSource,
      });
    } else if (existing) {
      // No grid in this message, just update lastSeenMs
      existing.lastSeenMs = timestamp;
    } else {
      // First time seeing this callsign, no grid yet
      this.entries.set(key, { lastSeenMs: timestamp });
    }
  }

  /**
   * Look up the last-known grid for a callsign.
   * Returns undefined if not found or if the entry has expired.
   */
  getGrid(callsign: string): string | undefined {
    const info = this.getInfo(callsign);
    return info?.grid;
  }

  /**
   * Look up the full context info for a callsign.
   * Returns undefined if not found or expired.
   */
  getInfo(callsign: string): CallsignInfo | undefined {
    const key = callsign.toUpperCase();
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.lastSeenMs > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }

    return entry;
  }

  /** Remove expired entries. */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenMs > this.ttlMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug(`cleanup removed ${removed} expired entries, ${this.entries.size} remaining`);
    }
  }

  /** Stop the cleanup timer and clear all entries. */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.entries.clear();
  }

  /** Number of tracked callsigns. */
  get size(): number {
    return this.entries.size;
  }
}
