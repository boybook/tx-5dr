import { describe, expect, it } from 'vitest';
import {
  isSecureRemoteAccessOrigin,
  normalizeRemoteAccessOrigin,
} from '../auth.schema.js';

describe('remote access origins', () => {
  it('normalizes exact browser origins and rejects paths or credentials', () => {
    expect(normalizeRemoteAccessOrigin('https://radio.example.com/')).toBe('https://radio.example.com');
    expect(normalizeRemoteAccessOrigin('http://10.8.0.2:8076')).toBe('http://10.8.0.2:8076');
    expect(normalizeRemoteAccessOrigin('https://radio.example.com/tx5dr')).toBeNull();
    expect(normalizeRemoteAccessOrigin('https://user:pass@radio.example.com')).toBeNull();
  });

  it('requires HTTPS for public hosts while allowing private-network HTTP', () => {
    expect(isSecureRemoteAccessOrigin('https://radio.example.com')).toBe(true);
    expect(isSecureRemoteAccessOrigin('http://radio.example.com')).toBe(false);
    expect(isSecureRemoteAccessOrigin('http://203.0.113.10:8076')).toBe(false);
    expect(isSecureRemoteAccessOrigin('http://192.168.1.20:8076')).toBe(true);
    expect(isSecureRemoteAccessOrigin('http://100.64.0.2:8076')).toBe(true);
  });
});
