import { QSORecordSchema, SlotPackSchema, type QSORecord, type SlotPack } from '@tx5dr/contracts';
import type { WSClient } from '@tx5dr/core';
import { ReplyNotificationTracker, type ReplyReceivedEvent } from './replyNotificationTracker';

export type ClientNotificationEvent = ReplyReceivedEvent | { type: 'qsoLogged'; record: QSORecord };

export interface NotificationEventSnapshot {
  callsigns: string[];
  mode: string | null;
  replyEnabled: boolean;
  slotPacks: SlotPack[];
  syncing: boolean;
}

export function subscribeClientNotificationEvents(
  client: Pick<WSClient, 'onWSEvent' | 'offWSEvent' | 'isReady'>,
  snapshot: () => NotificationEventSnapshot,
  deliver: (event: ClientNotificationEvent) => void,
): () => void {
  const replies = new ReplyNotificationTracker();
  let ready = client.isReady;
  const initial = snapshot();
  for (const pack of initial.slotPacks) replies.consume(pack, initial.callsigns, false);
  replies.setSyncing(initial.syncing);

  const handlePack = (data: unknown) => {
    const parsed = SlotPackSchema.safeParse(data);
    if (!parsed.success) return;
    const current = snapshot();
    const digital = current.mode === 'FT8' || current.mode === 'FT4';
    const event = replies.consume(parsed.data, current.callsigns, ready && digital && current.replyEnabled);
    if (event) deliver(event);
  };
  const handleReset = (data: unknown) => {
    const phase = data && typeof data === 'object' && 'phase' in data ? data.phase : undefined;
    // A legacy reset also suppresses events until the next completed handshake/sync.
    replies.setSyncing(phase !== 'complete');
  };
  const handleDisconnect = () => {
    ready = false;
    replies.reset();
  };
  const handleReady = () => {
    ready = true;
    replies.setSyncing(false);
  };
  const handleQso = (data: unknown) => {
    if (!ready || !data || typeof data !== 'object' || !('qsoRecord' in data)) return;
    const parsed = QSORecordSchema.safeParse(data.qsoRecord);
    if (parsed.success) deliver({ type: 'qsoLogged', record: parsed.data });
  };

  client.onWSEvent('slotPackUpdated', handlePack);
  client.onWSEvent('slotPacksReset', handleReset);
  client.onWSEvent('disconnected', handleDisconnect);
  client.onWSEvent('handshakeComplete', handleReady);
  client.onWSEvent('qsoRecordAdded', handleQso);
  return () => {
    client.offWSEvent('slotPackUpdated', handlePack);
    client.offWSEvent('slotPacksReset', handleReset);
    client.offWSEvent('disconnected', handleDisconnect);
    client.offWSEvent('handshakeComplete', handleReady);
    client.offWSEvent('qsoRecordAdded', handleQso);
    replies.reset();
  };
}
