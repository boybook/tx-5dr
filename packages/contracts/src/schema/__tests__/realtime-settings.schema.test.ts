import { describe, expect, it } from 'vitest';
import {
  RealtimeSessionRequestSchema,
  ResolvedRealtimeAudioCodecPolicySchema,
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

describe('Realtime audio codec schemas', () => {
  it('accepts codec preferences and client capabilities', () => {
    const parsed = RealtimeSessionRequestSchema.parse({
      scope: 'radio',
      direction: 'recv',
      audioCodecPreference: 'opus',
      audioCodecCapabilities: {
        opus: {
          decode: true,
          sampleRates: [48000, 24000, 16000, 12000],
          encodeSampleRates: [16000],
          decodeSampleRates: [48000, 24000, 16000, 12000],
        },
        pcmS16le: true,
      },
    });

    expect(parsed.audioCodecPreference).toBe('opus');
    expect(parsed.audioCodecCapabilities?.opus?.decode).toBe(true);
    expect(parsed.audioCodecCapabilities?.opus?.encodeSampleRates).toEqual([16000]);
  });

  it('defaults old clients to automatic codec negotiation', () => {
    const parsed = RealtimeSessionRequestSchema.parse({
      scope: 'radio',
      direction: 'recv',
    });

    expect(parsed.audioCodecPreference).toBe('auto');
  });

  it('describes resolved Opus and PCM fallback policies', () => {
    expect(ResolvedRealtimeAudioCodecPolicySchema.parse({
      preference: 'auto',
      resolvedCodec: 'opus',
      fallbackReason: null,
      codecSampleRate: null,
      bitrateBps: 32000,
      frameDurationMs: 20,
    }).resolvedCodec).toBe('opus');

    expect(ResolvedRealtimeAudioCodecPolicySchema.parse({
      preference: 'opus',
      resolvedCodec: 'pcm-s16le',
      fallbackReason: 'server-opus-unavailable',
      codecSampleRate: null,
      bitrateBps: null,
      frameDurationMs: null,
    }).fallbackReason).toBe('server-opus-unavailable');
  });
});

describe('VoiceTxBufferPreferenceSchema', () => {
  it('accepts auto and custom TX buffer profiles', () => {
    expect(VoiceTxBufferPreferenceSchema.parse({ profile: 'auto' }).profile).toBe('auto');
    expect(VoiceTxBufferPreferenceSchema.parse({
      profile: 'custom',
      customTargetBufferMs: '240',
    }).customTargetBufferMs).toBe(240);
  });

  it('migrates legacy TX buffer presets to auto', () => {
    expect(VoiceTxBufferPreferenceSchema.parse({ profile: 'low-latency' }).profile).toBe('auto');
    expect(VoiceTxBufferPreferenceSchema.parse({ profile: 'balanced' }).profile).toBe('auto');
    expect(VoiceTxBufferPreferenceSchema.parse({ profile: 'stable' }).profile).toBe('auto');
  });

  it('rejects invalid custom TX buffer targets', () => {
    expect(() => VoiceTxBufferPreferenceSchema.parse({ profile: 'custom' })).toThrow();
    expect(() => VoiceTxBufferPreferenceSchema.parse({ profile: 'custom', customTargetBufferMs: 39 })).toThrow();
    expect(() => VoiceTxBufferPreferenceSchema.parse({ profile: 'custom', customTargetBufferMs: 501 })).toThrow();
  });

  it('defaults send sessions to auto when no preference is provided', () => {
    const parsed = RealtimeSessionRequestSchema.parse({
      scope: 'radio',
      direction: 'send',
    });
    expect(parsed.voiceTxBufferPreference).toBeUndefined();
    expect(resolveVoiceTxBufferPolicy(parsed.voiceTxBufferPreference).targetMs).toBe(80);
  });

  it('resolves automatic and custom TX buffer policies', () => {
    expect(resolveVoiceTxBufferPolicy({ profile: 'auto' })).toMatchObject({
      profile: 'auto',
      targetMs: 80,
      minMs: 60,
      maxMs: 400,
    });
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
