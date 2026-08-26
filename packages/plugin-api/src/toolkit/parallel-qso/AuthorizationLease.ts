export interface AuthorizationLeaseCheckpoint {
  authorizationId: string;
  authorizedAtCycle: number;
  expiresAfterReceiveCycles: number;
}

/** Mode-relative authorization freshness for manually queued work. */
export class AuthorizationLease {
  constructor(private state: AuthorizationLeaseCheckpoint) {
    if (!state.authorizationId || !Number.isInteger(state.authorizedAtCycle)) {
      throw new Error('Invalid authorization lease');
    }
    if (!Number.isInteger(state.expiresAfterReceiveCycles) || state.expiresAfterReceiveCycles < 1) {
      throw new Error('Authorization lease expiry must be a positive integer');
    }
  }

  get authorizationId(): string { return this.state.authorizationId; }

  isFresh(currentReceiveCycle: number): boolean {
    return currentReceiveCycle - this.state.authorizedAtCycle < this.state.expiresAfterReceiveCycles;
  }

  reauthorize(authorizationId: string, currentReceiveCycle: number): void {
    if (!authorizationId) throw new Error('authorizationId must not be empty');
    this.state = { ...this.state, authorizationId, authorizedAtCycle: currentReceiveCycle };
  }

  checkpoint(): AuthorizationLeaseCheckpoint {
    return structuredClone(this.state);
  }
}
