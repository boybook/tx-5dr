export interface RecoveryMatch<TMessage, TAction> {
  matches(message: TMessage): boolean;
  action: TAction;
}

/** Protocol-neutral receive-cycle lease for post-completion recovery. */
export class PostCompletionRecoveryLease<TMessage, TAction> {
  private remainingReceiveCycles: number;

  constructor(
    receiveCycles: number,
    private readonly matches: readonly RecoveryMatch<TMessage, TAction>[],
  ) {
    if (!Number.isInteger(receiveCycles) || receiveCycles < 1) {
      throw new Error('Recovery receive cycles must be a positive integer');
    }
    this.remainingReceiveCycles = receiveCycles;
  }

  get active(): boolean { return this.remainingReceiveCycles > 0; }

  observe(messages: readonly TMessage[]): TAction[] {
    if (!this.active) return [];
    return messages.flatMap((message) => {
      const match = this.matches.find((candidate) => candidate.matches(message));
      return match ? [structuredClone(match.action)] : [];
    });
  }

  advanceReceiveCycle(): void {
    this.remainingReceiveCycles = Math.max(0, this.remainingReceiveCycles - 1);
  }

  checkpoint(): { remainingReceiveCycles: number } {
    return { remainingReceiveCycles: this.remainingReceiveCycles };
  }

  restore(checkpoint: { remainingReceiveCycles: number }): void {
    this.remainingReceiveCycles = Math.max(0, Math.trunc(checkpoint.remainingReceiveCycles));
  }
}
