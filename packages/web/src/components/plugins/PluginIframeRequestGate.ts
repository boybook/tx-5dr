export class PluginIframeRequestGate<TRequest> {
  private lockedPageSessionId: string | null = null;
  private pendingRequests: TRequest[] = [];

  getLockedPageSessionId(): string | null {
    return this.lockedPageSessionId;
  }

  dispatchOrQueue(
    request: TRequest,
    dispatch: (request: TRequest, pageSessionId: string) => void,
  ): boolean {
    if (!this.lockedPageSessionId) {
      this.pendingRequests.push(request);
      return false;
    }

    dispatch(request, this.lockedPageSessionId);
    return true;
  }

  lock(pageSessionId: string): TRequest[] {
    this.lockedPageSessionId = pageSessionId;
    const pendingRequests = this.pendingRequests;
    this.pendingRequests = [];
    return pendingRequests;
  }

  unlock(): void {
    this.lockedPageSessionId = null;
  }

  dropPending(): TRequest[] {
    const pendingRequests = this.pendingRequests;
    this.pendingRequests = [];
    return pendingRequests;
  }
}
