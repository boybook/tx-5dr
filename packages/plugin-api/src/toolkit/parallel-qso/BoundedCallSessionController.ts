export type BoundedCallSessionState =
  | 'idle'
  | 'calling'
  | 'collecting'
  | 'batch-active'
  | 'draining'
  | 'completed'
  | 'no-response';

export interface BoundedCallSessionCheckpoint {
  state: BoundedCallSessionState;
  authorizationId?: string;
  successfulCalls: number;
  maxAttempts: number;
  capacity: number;
  responseSlotId?: string;
  selectedTargetKeys: string[];
  consumedReason?: string;
}

/** Protocol-neutral, checkpointable authorization for one bounded call/search session. */
export class BoundedCallSessionController {
  private data: BoundedCallSessionCheckpoint = {
    state: 'idle', successfulCalls: 0, maxAttempts: 1, capacity: 1, selectedTargetKeys: [],
  };

  get state(): BoundedCallSessionState { return this.data.state; }
  get authorizationId(): string | undefined { return this.data.authorizationId; }
  get successfulCalls(): number { return this.data.successfulCalls; }
  get maxAttempts(): number { return this.data.maxAttempts; }
  get capacity(): number { return this.data.capacity; }
  get responseSlotId(): string | undefined { return this.data.responseSlotId; }
  get selectedTargetKeys(): readonly string[] { return this.data.selectedTargetKeys; }
  get isArmed(): boolean {
    return this.data.state === 'calling' || this.data.state === 'collecting' || this.data.state === 'batch-active';
  }
  get attemptsExhausted(): boolean { return this.data.successfulCalls >= this.data.maxAttempts; }

  arm(input: { authorizationId: string; maxAttempts: number; capacity: number }): void {
    if (!input.authorizationId) throw new Error('authorizationId must not be empty');
    this.data = {
      state: 'calling',
      authorizationId: input.authorizationId,
      successfulCalls: 0,
      maxAttempts: Math.max(1, Math.trunc(input.maxAttempts)),
      capacity: Math.max(1, Math.trunc(input.capacity)),
      selectedTargetKeys: [],
    };
  }

  onPhysicalCallSuccess(): boolean {
    if (this.data.state !== 'calling') return false;
    this.data.successfulCalls += 1;
    return true;
  }

  beginCollecting(responseSlotId: string): boolean {
    if (!responseSlotId || !this.isArmed) return false;
    if (this.data.responseSlotId && this.data.responseSlotId !== responseSlotId) return false;
    if (this.data.state !== 'batch-active') this.data.state = 'collecting';
    this.data.responseSlotId = responseSlotId;
    return true;
  }

  activateBatch(targetKeys: readonly string[]): void {
    if (this.data.state !== 'collecting') throw new Error('call session is not collecting');
    const selected = [...new Set(targetKeys)].slice(0, this.data.capacity);
    this.data.selectedTargetKeys = selected;
    this.data.state = selected.length > 0 ? 'batch-active' : 'completed';
    this.data.consumedReason = selected.length > 0 ? 'batch-selected' : 'no-eligible-candidates';
  }

  extendBatch(targetKeys: readonly string[]): void {
    if (this.data.state !== 'batch-active') throw new Error('call session batch is not active');
    this.data.selectedTargetKeys = [...new Set([
      ...this.data.selectedTargetKeys,
      ...targetKeys,
    ])].slice(0, this.data.capacity);
  }

  beginDraining(): void {
    if (this.data.state === 'batch-active' || this.data.state === 'completed') this.data.state = 'draining';
  }

  finish(reason: string): void {
    this.data.state = 'completed';
    this.data.consumedReason = reason;
  }

  finishNoResponse(reason = 'no-response'): void {
    this.data.state = 'no-response';
    this.data.consumedReason = reason;
  }

  reset(): void {
    this.data = { state: 'idle', successfulCalls: 0, maxAttempts: 1, capacity: 1, selectedTargetKeys: [] };
  }

  checkpoint(): BoundedCallSessionCheckpoint { return structuredClone(this.data); }
  restore(checkpoint: BoundedCallSessionCheckpoint): void { this.data = structuredClone(checkpoint); }
}
