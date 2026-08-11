import { createHash, randomBytes } from 'node:crypto';

export const BROWSER_LOGIN_CODE_TTL_MS = 120_000;
export const MAX_BROWSER_LOGIN_CODES_PER_ISSUER = 8;
export const MAX_BROWSER_LOGIN_CODES_GLOBAL = 64;

interface BrowserLoginCodeRecord {
  issuerTokenId: string;
  createdAt: number;
  expiresAt: number;
}

export interface CreatedBrowserLoginCode {
  code: string;
  expiresAt: number;
}

export class BrowserLoginCodeCapacityError extends Error {
  constructor() {
    super('Too many outstanding browser login codes');
    this.name = 'BrowserLoginCodeCapacityError';
  }
}

export class BrowserLoginCodeStore {
  private readonly records = new Map<string, BrowserLoginCodeRecord>();

  create(issuerTokenId: string, now = Date.now()): CreatedBrowserLoginCode {
    this.pruneExpired(now);

    let issuerCount = 0;
    for (const record of this.records.values()) {
      if (record.issuerTokenId === issuerTokenId) issuerCount += 1;
    }

    if (
      issuerCount >= MAX_BROWSER_LOGIN_CODES_PER_ISSUER
      || this.records.size >= MAX_BROWSER_LOGIN_CODES_GLOBAL
    ) {
      throw new BrowserLoginCodeCapacityError();
    }

    const code = `txdr_blc_${randomBytes(32).toString('base64url')}`;
    const expiresAt = now + BROWSER_LOGIN_CODE_TTL_MS;
    this.records.set(this.digest(code), { issuerTokenId, createdAt: now, expiresAt });
    return { code, expiresAt };
  }

  consume(code: string, now = Date.now()): BrowserLoginCodeRecord | null {
    const digest = this.digest(code);
    const record = this.records.get(digest);
    if (!record) return null;

    // Delete before any further validation so every observed code is single-use.
    this.records.delete(digest);
    if (record.expiresAt <= now) return null;
    return record;
  }

  clear(): void {
    this.records.clear();
  }

  private pruneExpired(now: number): void {
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(digest);
    }
  }

  private digest(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
