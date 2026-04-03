export class VoicePttPressTracker {
  private nextPressId = 1;
  private activePressId: number | null = null;
  private requestIssuedPressId: number | null = null;

  beginPress(): number {
    const pressId = this.nextPressId++;
    this.activePressId = pressId;
    this.requestIssuedPressId = null;
    return pressId;
  }

  isActive(pressId: number): boolean {
    return this.activePressId === pressId;
  }

  markRequestIssued(pressId: number): boolean {
    if (!this.isActive(pressId)) {
      return false;
    }

    this.requestIssuedPressId = pressId;
    return true;
  }

  releaseActivePress(): { pressId: number | null; shouldRelease: boolean } {
    const pressId = this.activePressId;
    if (pressId === null) {
      return { pressId: null, shouldRelease: false };
    }

    const shouldRelease = this.requestIssuedPressId === pressId;
    this.activePressId = null;
    this.requestIssuedPressId = null;
    return { pressId, shouldRelease };
  }

  cancelPress(pressId: number): void {
    if (!this.isActive(pressId)) {
      return;
    }

    this.activePressId = null;
    if (this.requestIssuedPressId === pressId) {
      this.requestIssuedPressId = null;
    }
  }

  reset(): void {
    this.activePressId = null;
    this.requestIssuedPressId = null;
  }
}
