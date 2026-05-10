import { describe, expect, it } from 'vitest';
import { buildQrzCallsignUrl, isValidQrzCallsign, normalizeQrzCallsign } from '../QrzCallsignLink';

describe('QrzCallsignLink helpers', () => {
  it('builds QRZ URLs for valid callsigns', () => {
    expect(buildQrzCallsignUrl('BG5DRB')).toBe('https://www.qrz.com/db/BG5DRB');
    expect(buildQrzCallsignUrl('K1ABC')).toBe('https://www.qrz.com/db/K1ABC');
    expect(buildQrzCallsignUrl('JA1ABC')).toBe('https://www.qrz.com/db/JA1ABC');
  });

  it('normalizes lowercase and padded callsigns', () => {
    expect(normalizeQrzCallsign(' bg5drb ')).toBe('BG5DRB');
    expect(buildQrzCallsignUrl(' bg5drb ')).toBe('https://www.qrz.com/db/BG5DRB');
  });

  it('rejects empty and invalid callsigns', () => {
    expect(isValidQrzCallsign('')).toBe(false);
    expect(isValidQrzCallsign('ABC')).toBe(false);
    expect(isValidQrzCallsign('A1')).toBe(false);
    expect(buildQrzCallsignUrl('ABC')).toBeNull();
  });

  it('accepts portable callsigns and URL-encodes slash separators', () => {
    expect(isValidQrzCallsign('VK2/BG5DRB')).toBe(true);
    expect(buildQrzCallsignUrl('VK2/BG5DRB')).toBe('https://www.qrz.com/db/VK2%2FBG5DRB');
  });
});
