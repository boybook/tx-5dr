import type { PluginEventBus } from '../../helpers.js';

export class ContestSessionNotifier<TPayload> {
  constructor(private readonly eventBus: PluginEventBus, private readonly topic: string) {}

  publish(payload: TPayload): void {
    this.eventBus.publish(this.topic, payload);
  }

  subscribe(handler: (payload: TPayload) => void | Promise<void>): () => void {
    return this.eventBus.subscribe(this.topic, (message) => handler(message.payload as TPayload));
  }
}
