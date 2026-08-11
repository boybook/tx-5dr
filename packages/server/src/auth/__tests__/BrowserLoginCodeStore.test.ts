import { describe, expect, it } from 'vitest';
import {
  BROWSER_LOGIN_CODE_TTL_MS,
  BrowserLoginCodeCapacityError,
  BrowserLoginCodeStore,
  MAX_BROWSER_LOGIN_CODES_GLOBAL,
  MAX_BROWSER_LOGIN_CODES_PER_ISSUER,
} from '../BrowserLoginCodeStore.js';

describe('BrowserLoginCodeStore', () => {
  it('creates a random single-use code and stores only its lookup digest', () => {
    const store = new BrowserLoginCodeStore();
    const first = store.create('admin-1', 1_000);
    const second = store.create('admin-1', 1_000);

    expect(first.code).toMatch(/^txdr_blc_[A-Za-z0-9_-]{43}$/);
    expect(second.code).not.toBe(first.code);
    expect(first.expiresAt).toBe(1_000 + BROWSER_LOGIN_CODE_TTL_MS);
    expect(store.consume(first.code, 2_000)?.issuerTokenId).toBe('admin-1');
    expect(store.consume(first.code, 2_000)).toBeNull();
  });

  it('consumes expired codes without allowing a retry', () => {
    const store = new BrowserLoginCodeStore();
    const created = store.create('admin-1', 1_000);

    expect(store.consume(created.code, created.expiresAt)).toBeNull();
    expect(store.consume(created.code, 1_001)).toBeNull();
  });

  it('enforces per-issuer and global outstanding-code bounds', () => {
    const perIssuerStore = new BrowserLoginCodeStore();
    for (let index = 0; index < MAX_BROWSER_LOGIN_CODES_PER_ISSUER; index += 1) {
      perIssuerStore.create('admin-1', 1_000);
    }
    expect(() => perIssuerStore.create('admin-1', 1_000)).toThrow(BrowserLoginCodeCapacityError);

    const globalStore = new BrowserLoginCodeStore();
    for (let index = 0; index < MAX_BROWSER_LOGIN_CODES_GLOBAL; index += 1) {
      globalStore.create(`admin-${index}`, 1_000);
    }
    expect(() => globalStore.create('one-more-admin', 1_000)).toThrow(BrowserLoginCodeCapacityError);
  });

  it('prunes expired records before enforcing capacity', () => {
    const store = new BrowserLoginCodeStore();
    for (let index = 0; index < MAX_BROWSER_LOGIN_CODES_PER_ISSUER; index += 1) {
      store.create('admin-1', 1_000);
    }

    expect(() => store.create('admin-1', 1_000 + BROWSER_LOGIN_CODE_TTL_MS)).not.toThrow();
  });

  it('drops all codes when the store is cleared for server reinitialization', () => {
    const store = new BrowserLoginCodeStore();
    const created = store.create('admin-1');

    store.clear();
    expect(store.consume(created.code)).toBeNull();
  });
});
