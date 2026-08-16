const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_CONCURRENT_PER_IP = 2;

export type LoginAdmission =
  | { allowed: true; release: () => void }
  | { allowed: false; retryAfterMs: number; reason: 'rate_limit' | 'concurrency_limit' };

export class LoginAttemptLimiter {
  private attempts = new Map<string, number[]>();
  private activeByIp = new Map<string, number>();
  private activeTotal = 0;
  private lastCleanupAt = 0;

  constructor(
    private readonly windowMs = DEFAULT_WINDOW_MS,
    private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS,
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT,
    private readonly maxConcurrentPerIp = DEFAULT_MAX_CONCURRENT_PER_IP,
  ) {}

  acquire(clientIp: string, accountKey?: string): LoginAdmission {
    const now = Date.now();
    if (now - this.lastCleanupAt >= this.windowMs) {
      this.lastCleanupAt = now;
      for (const [key, timestamps] of this.attempts) {
        const recent = timestamps.filter(timestamp => now - timestamp < this.windowMs);
        if (recent.length > 0) this.attempts.set(key, recent);
        else this.attempts.delete(key);
      }
    }
    const keys = [`ip:${clientIp}`, ...(accountKey ? [`account:${accountKey}`] : [])];
    let retryAfterMs = 0;

    for (const key of keys) {
      const recent = (this.attempts.get(key) ?? []).filter(timestamp => now - timestamp < this.windowMs);
      if (recent.length > 0) this.attempts.set(key, recent);
      else this.attempts.delete(key);
      if (recent.length >= this.maxAttempts) {
        retryAfterMs = Math.max(retryAfterMs, this.windowMs - (now - recent[0]));
      }
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs, reason: 'rate_limit' };

    const activeForIp = this.activeByIp.get(clientIp) ?? 0;
    if (this.activeTotal >= this.maxConcurrent || activeForIp >= this.maxConcurrentPerIp) {
      return { allowed: false, retryAfterMs: 1_000, reason: 'concurrency_limit' };
    }

    for (const key of keys) {
      this.attempts.set(key, [...(this.attempts.get(key) ?? []), now]);
    }
    this.activeTotal += 1;
    this.activeByIp.set(clientIp, activeForIp + 1);

    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.activeTotal = Math.max(0, this.activeTotal - 1);
        const remaining = (this.activeByIp.get(clientIp) ?? 1) - 1;
        if (remaining > 0) this.activeByIp.set(clientIp, remaining);
        else this.activeByIp.delete(clientIp);
      },
    };
  }
}
