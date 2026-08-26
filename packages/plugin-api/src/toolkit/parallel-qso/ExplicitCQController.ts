export type ExplicitCQMode = 'off' | 'once' | 'repeat';

/** Explicit CQ arming separate from the Host's operator transmit permission. */
export class ExplicitCQController {
  private mode: ExplicitCQMode = 'off';
  private suppressed = false;

  get currentMode(): ExplicitCQMode { return this.mode; }
  get isSuppressed(): boolean { return this.suppressed; }

  setMode(mode: ExplicitCQMode): void { this.mode = mode; }
  setSuppressed(suppressed: boolean): void { this.suppressed = suppressed; }

  shouldTransmit(): boolean {
    return !this.suppressed && this.mode !== 'off';
  }

  onPhysicalSuccess(): void {
    if (this.mode === 'once') this.mode = 'off';
  }

  checkpoint(): { mode: ExplicitCQMode; suppressed: boolean } {
    return { mode: this.mode, suppressed: this.suppressed };
  }

  restore(checkpoint: { mode: ExplicitCQMode; suppressed: boolean }): void {
    this.mode = checkpoint.mode;
    this.suppressed = checkpoint.suppressed;
  }
}
