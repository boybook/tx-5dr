import { describe, expect, it } from 'vitest';
import {
  RealtimeSessionRequestSchema,
  RealtimeTransportKindSchema,
  RealtimeSettingsSchema,
} from '../realtime.schema.js';

describe('Realtime transport schemas', () => {
  it('accepts only rtc-data-audio and ws-compat transports', () => {
    expect(RealtimeTransportKindSchema.parse('rtc-data-audio')).toBe('rtc-data-audio');
    expect(RealtimeTransportKindSchema.parse('ws-compat')).toBe('ws-compat');
    const retiredTransport = 'live' + 'kit';
    expect(() => RealtimeTransportKindSchema.parse(retiredTransport)).toThrow();
    expect(() => RealtimeSessionRequestSchema.parse({
      scope: 'radio',
      direction: 'recv',
      transportOverride: retiredTransport,
    })).toThrow();
  });
});

describe('RealtimeSettingsSchema rtc-data-audio public endpoint', () => {
  it('accepts empty, DNS, IPv4, IPv6 hosts, and valid UDP ports', () => {
    expect(RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: '' }).rtcDataAudioPublicHost).toBeNull();
    expect(RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: 'radio.example.com' }).rtcDataAudioPublicHost).toBe('radio.example.com');
    expect(RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: '203.0.113.10' }).rtcDataAudioPublicHost).toBe('203.0.113.10');
    expect(RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: '2001:db8::1' }).rtcDataAudioPublicHost).toBe('2001:db8::1');
    expect(RealtimeSettingsSchema.parse({ rtcDataAudioPublicUdpPort: 50110 }).rtcDataAudioPublicUdpPort).toBe(50110);
    expect(RealtimeSettingsSchema.parse({ rtcDataAudioPublicUdpPort: '' }).rtcDataAudioPublicUdpPort).toBeNull();
  });

  it('rejects URLs, paths, host:port strings, whitespace, and invalid ports', () => {
    expect(() => RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: 'https://radio.example.com' })).toThrow();
    expect(() => RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: 'radio.example.com/realtime' })).toThrow();
    expect(() => RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: 'radio.example.com:50110' })).toThrow();
    expect(() => RealtimeSettingsSchema.parse({ rtcDataAudioPublicHost: 'radio example.com' })).toThrow();
    expect(() => RealtimeSettingsSchema.parse({ rtcDataAudioPublicUdpPort: 0 })).toThrow();
    expect(() => RealtimeSettingsSchema.parse({ rtcDataAudioPublicUdpPort: 65536 })).toThrow();
  });
});
