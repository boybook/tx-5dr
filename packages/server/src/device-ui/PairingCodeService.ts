import { randomInt, randomUUID } from 'crypto';

const PAIRING_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const IP_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_FAILURES_PER_CODE = 5;
const MAX_FAILURES_PER_IP = 10;

interface PairingCodeRecord {
  id: string;
  code: string;
  expiresAt: number;
  failures: number;
}

interface PairingSessionRecord {
  tokenId: string;
  expiresAt: number;
}

export class PairingCodeService {
  private static instance: PairingCodeService | null = null;
  private codes = new Map<string, PairingCodeRecord>();
  private sessions = new Map<string, PairingSessionRecord>();
  private ipFailures = new Map<string, number[]>();

  static getInstance(): PairingCodeService {
    if (!PairingCodeService.instance) {
      PairingCodeService.instance = new PairingCodeService();
    }
    return PairingCodeService.instance;
  }

  createCode(): PairingCodeRecord {
    this.cleanup();
    let code = '';
    do {
      code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    } while (this.codes.has(code));

    const record = {
      id: randomUUID(),
      code,
      expiresAt: Date.now() + PAIRING_TTL_MS,
      failures: 0,
    };
    this.codes.set(code, record);
    return record;
  }

  getCode(id: string): PairingCodeRecord | null {
    this.cleanup();
    return Array.from(this.codes.values()).find(record => record.id === id) ?? null;
  }

  consumeCode(code: string, ip: string): PairingSessionRecord | { error: 'RATE_LIMITED' | 'INVALID_CODE' | 'EXPIRED_CODE' } {
    this.cleanup();
    if (this.isIpRateLimited(ip)) {
      return { error: 'RATE_LIMITED' };
    }

    const record = this.codes.get(code);
    if (!record) {
      this.recordIpFailure(ip);
      return { error: 'INVALID_CODE' };
    }

    if (record.expiresAt <= Date.now()) {
      this.codes.delete(code);
      this.recordIpFailure(ip);
      return { error: 'EXPIRED_CODE' };
    }

    if (record.failures >= MAX_FAILURES_PER_CODE) {
      this.codes.delete(code);
      this.recordIpFailure(ip);
      return { error: 'INVALID_CODE' };
    }

    this.codes.delete(code);
    const session = {
      tokenId: `pairing-session-${randomUUID()}`,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.tokenId, session);
    return session;
  }

  getSession(tokenId: string): PairingSessionRecord | null {
    this.cleanup();
    return this.sessions.get(tokenId) ?? null;
  }

  private recordIpFailure(ip: string): void {
    const now = Date.now();
    const failures = (this.ipFailures.get(ip) ?? []).filter(ts => now - ts < IP_FAILURE_WINDOW_MS);
    failures.push(now);
    this.ipFailures.set(ip, failures);
  }

  private isIpRateLimited(ip: string): boolean {
    const now = Date.now();
    const failures = (this.ipFailures.get(ip) ?? []).filter(ts => now - ts < IP_FAILURE_WINDOW_MS);
    this.ipFailures.set(ip, failures);
    return failures.length >= MAX_FAILURES_PER_IP;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= now) this.codes.delete(code);
    }
    for (const [tokenId, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(tokenId);
    }
  }
}
