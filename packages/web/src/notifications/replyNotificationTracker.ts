import { FT8MessageParser } from '@tx5dr/core';
import type { SlotPack } from '@tx5dr/contracts';

const REARM_MS = 120_000;
const MAX_SLOTS = 128;
const MAX_PAIRS = 1000;
const normalizeCallsign = (value: string) => value.trim().toUpperCase().replace(/^<(.+)>$/, '$1');

export interface ReplyReceivedEvent {
  type: 'replyReceived';
  slotId: string;
}

export function getDirectedReplyPairs(message: string, myCallsigns: readonly string[]): string[] {
  if (FT8MessageParser.rawContainsUndecodedCallsign(message)) return [];
  const parsed = FT8MessageParser.parseMessage(message);
  if (!('senderCallsign' in parsed) || !parsed.senderCallsign) return [];
  const sender = normalizeCallsign(parsed.senderCallsign);
  if (!/[A-Z]/.test(sender) || !/\d/.test(sender)) return [];
  // The display parser tolerates trailing text; notifications require a complete directed form.
  if (parsed.type !== 'fox_rr73') {
    const tokens = message.trim().split(/\s+/);
    if (parsed.type === 'call') {
      if (tokens.length !== 2 && !(tokens.length === 3 && parsed.grid)) return [];
    } else if (tokens.length !== 3) return [];
  }
  const mine = new Set(myCallsigns.map(normalizeCallsign).filter(Boolean));
  if (mine.has(sender) || FT8MessageParser.isUndecodedCallsignPlaceholder(sender)) return [];
  const targets = parsed.type === 'fox_rr73'
    ? [parsed.completedCallsign, parsed.nextCallsign]
    : 'targetCallsign' in parsed ? [parsed.targetCallsign] : [];
  return [...new Set(targets.map(normalizeCallsign))]
    .filter(target => mine.has(target))
    .map(target => `${target}:${sender}`);
}

/** Consumes both live and replayed packs; only live, previously unseen replies can alert. */
export class ReplyNotificationTracker {
  private slots = new Map<string, { messages: Set<string>; handled: boolean; sequence?: number }>();
  private lastSeen = new Map<string, number>();
  private latestStartMs = -Infinity;
  private syncing = false;

  setSyncing(syncing: boolean): void { this.syncing = syncing; }

  reset(): void {
    this.slots.clear();
    this.lastSeen.clear();
    this.latestStartMs = -Infinity;
    this.syncing = false;
  }

  consume(pack: SlotPack, callsigns: readonly string[], live: boolean): ReplyReceivedEvent | null {
    if (!Number.isFinite(pack.startMs)) return null;
    const key = `${pack.slotId}:${pack.startMs}`;
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { messages: new Set(), handled: false };
      this.slots.set(key, slot);
      if (this.slots.size > MAX_SLOTS) this.slots.delete(this.slots.keys().next().value!);
    }
    const sequence = pack.stats.updateSeq;
    if (sequence !== undefined && slot.sequence !== undefined && sequence < slot.sequence) return null;
    slot.sequence = sequence ?? slot.sequence;
    const canNotify = live && !this.syncing && pack.startMs >= this.latestStartMs;
    this.latestStartMs = Math.max(this.latestStartMs, pack.startMs);
    let firstReply = false;
    for (const frame of pack.frames) {
      if (frame.snr === -999 || frame.operatorId) continue;
      const message = frame.message.trim().toUpperCase().replace(/\s+/g, ' ');
      if (slot.messages.has(message)) continue;
      slot.messages.add(message);
      for (const pair of getDirectedReplyPairs(message, callsigns)) {
        const previous = this.lastSeen.get(pair);
        if (previous === undefined || pack.startMs - previous >= REARM_MS) firstReply = true;
        this.lastSeen.delete(pair);
        this.lastSeen.set(pair, Math.max(previous ?? -Infinity, pack.startMs));
      }
    }
    for (const [pair, timestamp] of this.lastSeen) {
      if (this.latestStartMs - timestamp >= REARM_MS) this.lastSeen.delete(pair);
    }
    while (this.lastSeen.size > MAX_PAIRS) this.lastSeen.delete(this.lastSeen.keys().next().value!);
    if (!firstReply || slot.handled) return null;
    slot.handled = true;
    return canNotify ? { type: 'replyReceived', slotId: pack.slotId } : null;
  }
}
