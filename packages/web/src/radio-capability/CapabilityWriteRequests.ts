import { WSMessageType, WSRadioCapabilityChangedMessageSchema, WSErrorMessageSchema, type WriteCapabilityPayload } from '@tx5dr/contracts';
import type { WSClient } from '@tx5dr/core';
import type { CapabilityWriteFeedback } from './control-types';
import { createClientId } from '../utils/clientId';

export const CAPABILITY_WRITE_CONFIRM_TIMEOUT_MS = 5000;
type Port = Pick<WSClient, 'send' | 'onRawMessage' | 'off'>;
interface PendingWrite {
  capabilityId: string;
  resolve: (feedback: CapabilityWriteFeedback) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Correlates existing WS envelope IDs. Only pending writes need a raw-message listener. */
export class CapabilityWriteRequests {
  private pending = new Map<string, PendingWrite>();
  private disposed = false;
  constructor(private client: Port | undefined) {}

  write(payload: WriteCapabilityPayload): Promise<CapabilityWriteFeedback> {
    if (this.disposed || !this.client) return Promise.resolve({ outcome: 'cancelled' });
    const requestId = createClientId();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finish(requestId, { outcome: 'failed', error: 'Radio setting confirmation timed out', timedOut: true }), CAPABILITY_WRITE_CONFIRM_TIMEOUT_MS);
      const attach = this.pending.size === 0;
      this.pending.set(requestId, { capabilityId: payload.id, resolve, timer });
      try {
        if (attach) this.client!.onRawMessage(this.onMessage);
        this.client!.send(WSMessageType.WRITE_RADIO_CAPABILITY, payload, requestId);
      } catch (error) {
        this.finish(requestId, { outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private onMessage = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'string' || !('type' in message)) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.type === WSMessageType.RADIO_CAPABILITY_CHANGED) {
      const parsed = WSRadioCapabilityChangedMessageSchema.safeParse(message);
      if (parsed.success && parsed.data.data.id === request.capabilityId) this.finish(message.id, { outcome: 'completed', state: parsed.data.data });
    } else if (message.type === WSMessageType.ERROR) {
      const parsed = WSErrorMessageSchema.safeParse(message);
      if (parsed.success) this.finish(message.id, { outcome: 'failed', error: parsed.data.data.userMessage ?? parsed.data.data.message });
    }
  };

  private finish(id: string, feedback: CapabilityWriteFeedback) {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer); this.pending.delete(id);
    if (this.pending.size === 0) this.client?.off('rawMessage', this.onMessage);
    request.resolve(feedback);
  }

  dispose() {
    this.disposed = true;
    for (const id of this.pending.keys()) this.finish(id, { outcome: 'cancelled' });
  }
}
