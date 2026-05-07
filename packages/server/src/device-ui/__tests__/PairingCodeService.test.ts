import { describe, expect, it } from 'vitest';
import { PairingCodeService } from '../PairingCodeService.js';

describe('PairingCodeService', () => {
  it('creates six digit one-time viewer sessions without persisting auth tokens', () => {
    const service = new PairingCodeService();
    const code = service.createCode();

    expect(code.code).toMatch(/^\d{6}$/);
    expect(code.expiresAt).toBeGreaterThan(Date.now());

    const consumed = service.consumeCode(code.code, '127.0.0.1');
    expect(consumed).toMatchObject({ tokenId: expect.stringMatching(/^pairing-session-/) });
    if (!('error' in consumed)) {
      expect(service.getSession(consumed.tokenId)).toEqual(consumed);
    }

    expect(service.consumeCode(code.code, '127.0.0.1')).toEqual({ error: 'INVALID_CODE' });
  });

  it('rate limits repeated invalid consume attempts by IP', () => {
    const service = new PairingCodeService();
    for (let i = 0; i < 10; i += 1) {
      expect(service.consumeCode('000000', '192.0.2.1')).toEqual({ error: 'INVALID_CODE' });
    }
    expect(service.consumeCode('000000', '192.0.2.1')).toEqual({ error: 'RATE_LIMITED' });
  });
});
