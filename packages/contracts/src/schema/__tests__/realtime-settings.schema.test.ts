import { describe, expect, it } from 'vitest';
import {
  RealtimeSessionRequestSchema,
  RealtimeTransportKindSchema,
  RealtimeSettingsSchema,
  resolveVoiceTxBufferPolicy,
  VoiceTxBufferPreferenceSchema,
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

describe('VoiceTxBufferPreferenceSchema', () => {
  it('accepts preset and custom TX buffer profiles', () => {
    expect(VoiceTxBufferPreferenceSchema.parse({ profile: 'low-latency' }).profile).toBe('low-latency');
    expect(VoiceTxBufferPreferenceSchema.parse({ profile: 'balanced' }).profile).toBe('balanced');
    expect(VoiceTxBufferPreferenceSchema.parse({ profile: 'stable' }).profile).toBe('stable');
    expect(VoiceTxBufferPreferenceSchema.parse({
      profile: 'custom',
      customTargetBufferMs: '240',
    }).customTargetBufferMs).toBe(240);
  });

  it('rejects invalid custom TX buffer targets', () => {
    expect(() => VoiceTxBufferPreferenceSchema.parse({ profile: 'custom' })).toThrow();
    expect(() => VoiceTxBufferPreferenceSchema.parse({ profile: 'custom', customTargetBufferMs: 39 })).toThrow();
    expect(() => VoiceTxBufferPreferenceSchema.parse({ profile: 'custom', customTargetBufferMs: 501 })).toThrow();
  });

  it('defaults send sessions to balanced when no preference is provided', () => {
    const parsed = RealtimeSessionRequestSchema.parse({
      scope: 'radio',
      direction: 'send',
    });
    expect(parsed.voiceTxBufferPreference).toBeUndefined();
    expect(resolveVoiceTxBufferPolicy(parsed.voiceTxBufferPreference).targetMs).toBe(90);
  });

  it('resolves different TX buffer presets to different jitter budgets', () => {
    expect(resolveVoiceTxBufferPolicy({ profile: 'low-latency' }).targetMs).toBe(40);
    expect(resolveVoiceTxBufferPolicy({ profile: 'balanced' }).targetMs).toBe(90);
    expect(resolveVoiceTxBufferPolicy({ profile: 'stable' }).targetMs).toBe(170);
    expect(resolveVoiceTxBufferPolicy({
      profile: 'custom',
      customTargetBufferMs: 250,
    })).toMatchObject({
      profile: 'custom',
      targetMs: 250,
    });
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
