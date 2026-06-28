import type { PluginEventBusMessage } from '@tx5dr/plugin-api';

type PluginEventBusInstanceScope = 'operator' | 'global';

export interface PluginEventBusOwner {
  pluginName: string;
  instanceScope: PluginEventBusInstanceScope;
  operatorId?: string;
}

type SubscriptionHandler = (message: PluginEventBusMessage) => void | Promise<void>;

interface SubscriptionRecord {
  owner: PluginEventBusOwner;
  ownerKey: string;
  handler: SubscriptionHandler;
}

export interface PluginEventBusLogEntry {
  subscriber: PluginEventBusOwner;
  message: PluginEventBusMessage;
  error: unknown;
}

export class PluginEventBusHost {
  private readonly subscriptionsByTopic = new Map<string, Set<SubscriptionRecord>>();
  private readonly subscriptionsByOwnerKey = new Map<string, Set<{ topic: string; record: SubscriptionRecord }>>();

  constructor(
    private readonly onSubscriberError?: (entry: PluginEventBusLogEntry) => void,
  ) {}

  publish(owner: PluginEventBusOwner, topic: string, payload?: unknown): void {
    const message: PluginEventBusMessage = {
      topic,
      payload,
      timestamp: Date.now(),
      publisher: {
        pluginName: owner.pluginName,
        instanceScope: owner.instanceScope,
        operatorId: owner.operatorId,
      },
    };

    const subscribers = [...(this.subscriptionsByTopic.get(topic) ?? [])];
    for (const subscription of subscribers) {
      let result: void | Promise<void>;
      try {
        result = subscription.handler(message);
      } catch (error) {
        this.onSubscriberError?.({
          subscriber: subscription.owner,
          message,
          error,
        });
        continue;
      }

      void Promise.resolve(result).catch((error) => {
        this.onSubscriberError?.({
          subscriber: subscription.owner,
          message,
          error,
        });
      });
    }
  }

  subscribe(
    owner: PluginEventBusOwner,
    topic: string,
    handler: SubscriptionHandler,
  ): () => void {
    const ownerKey = this.getOwnerKey(owner);
    const topicSubscriptions = this.subscriptionsByTopic.get(topic) ?? new Set<SubscriptionRecord>();
    const existingRecord = [...topicSubscriptions].find((subscription) => (
      subscription.ownerKey === ownerKey && subscription.handler === handler
    ));
    if (existingRecord) {
      const ownerSubscription = [...(this.subscriptionsByOwnerKey.get(ownerKey) ?? [])]
        .find((subscription) => subscription.topic === topic && subscription.record === existingRecord);
      return () => {
        if (ownerSubscription) {
          this.removeSubscription(ownerKey, ownerSubscription);
        }
      };
    }

    const record: SubscriptionRecord = { owner, ownerKey, handler };
    topicSubscriptions.add(record);
    this.subscriptionsByTopic.set(topic, topicSubscriptions);

    const ownerSubscriptions = this.subscriptionsByOwnerKey.get(ownerKey) ?? new Set<{ topic: string; record: SubscriptionRecord }>();
    const ownerSubscription = { topic, record };
    ownerSubscriptions.add(ownerSubscription);
    this.subscriptionsByOwnerKey.set(ownerKey, ownerSubscriptions);

    return () => {
      this.removeSubscription(ownerKey, ownerSubscription);
    };
  }

  unsubscribeAll(owner: PluginEventBusOwner): void {
    const ownerKey = this.getOwnerKey(owner);
    const ownerSubscriptions = this.subscriptionsByOwnerKey.get(ownerKey);
    if (!ownerSubscriptions) {
      return;
    }

    for (const ownerSubscription of [...ownerSubscriptions]) {
      this.removeSubscription(ownerKey, ownerSubscription);
    }
  }

  private removeSubscription(
    ownerKey: string,
    ownerSubscription: { topic: string; record: SubscriptionRecord },
  ): void {
    const topicSubscriptions = this.subscriptionsByTopic.get(ownerSubscription.topic);
    if (topicSubscriptions) {
      topicSubscriptions.delete(ownerSubscription.record);
      if (topicSubscriptions.size === 0) {
        this.subscriptionsByTopic.delete(ownerSubscription.topic);
      }
    }

    const ownerSubscriptions = this.subscriptionsByOwnerKey.get(ownerKey);
    if (!ownerSubscriptions) {
      return;
    }
    ownerSubscriptions.delete(ownerSubscription);
    if (ownerSubscriptions.size === 0) {
      this.subscriptionsByOwnerKey.delete(ownerKey);
    }
  }

  private getOwnerKey(owner: PluginEventBusOwner): string {
    return `${owner.pluginName}:${owner.instanceScope}:${owner.operatorId ?? '__global__'}`;
  }
}
