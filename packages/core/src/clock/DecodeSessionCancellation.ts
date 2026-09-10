/** Internal receive-work lifecycle, independent of radio/PTT ownership. */
export type DecodeSessionCancelReason =
  | 'transmit-skipped' | 'capture-failed' | 'scheduler-reset' | 'stopped'
  | 'session-expired' | 'queue-expired' | 'worker-failed' | 'completed';

export class DecodeSessionCancelledError extends Error {
  readonly code = 'DECODE_SESSION_CANCELLED';
  constructor(readonly reason: DecodeSessionCancelReason) {
    super(`Decode session cancelled (${reason})`);
    this.name = 'DecodeSessionCancelledError';
  }
}

export function isDecodeSessionCancelled(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'DECODE_SESSION_CANCELLED';
}
