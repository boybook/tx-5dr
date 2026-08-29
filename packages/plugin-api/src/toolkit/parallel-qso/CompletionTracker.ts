import type { StrategyCompletionProjection, StrategyQSOCompletionEffect } from '../../runtime.js';

export class CompletionTracker {
  private effect?: StrategyQSOCompletionEffect;
  private state: StrategyCompletionProjection['state'] = 'not-ready';

  get projection(): StrategyCompletionProjection { return { state: this.state, recordId: this.effect?.record.id }; }
  get pendingEffect(): StrategyQSOCompletionEffect | undefined { return this.effect ? structuredClone(this.effect) : undefined; }

  markReady(): void { if (this.state === 'not-ready') this.state = 'ready'; }
  begin(effect: StrategyQSOCompletionEffect): void { this.effect = structuredClone(effect); this.state = 'committing'; }
  settle(status: 'committed' | 'failed'): void { this.state = status; }
  reset(): void { this.effect = undefined; this.state = 'not-ready'; }

  checkpoint(): { effect?: StrategyQSOCompletionEffect; state: StrategyCompletionProjection['state'] } {
    return structuredClone({ effect: this.effect, state: this.state });
  }

  restore(checkpoint: { effect?: StrategyQSOCompletionEffect; state: StrategyCompletionProjection['state'] }): void {
    this.effect = checkpoint.effect ? structuredClone(checkpoint.effect) : undefined;
    this.state = checkpoint.state;
  }
}
