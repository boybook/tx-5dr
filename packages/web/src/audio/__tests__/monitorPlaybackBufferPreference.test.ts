import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY,
  MONITOR_PLAYBACK_JITTER_SEED_STORAGE_KEY,
  MONITOR_PLAYBACK_BUFFER_STORAGE_KEY,
  loadMonitorPlaybackJitterSeed,
  loadMonitorPlaybackBufferPreference,
  normalizeMonitorPlaybackBufferPreference,
  normalizeMonitorPlaybackJitterSeed,
  resolveMonitorPlaybackBufferPolicy,
  resolveMonitorPlaybackJitterSeedTargetMs,
  saveMonitorPlaybackJitterSeed,
  saveMonitorPlaybackBufferPreference,
} from '../monitorPlaybackBufferPreference';

describe('monitor playback buffer preference', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalWindow !== undefined) {
      vi.stubGlobal('window', originalWindow);
    }
  });

  it('falls back to auto for missing or invalid values', () => {
    expect(normalizeMonitorPlaybackBufferPreference(null)).toEqual({ profile: 'auto' });
    expect(normalizeMonitorPlaybackBufferPreference({ profile: 'stable' })).toEqual({ profile: 'auto' });
    expect(loadMonitorPlaybackBufferPreference()).toEqual({ profile: 'auto' });

    window.localStorage.setItem(MONITOR_PLAYBACK_BUFFER_STORAGE_KEY, '{bad json');
    expect(loadMonitorPlaybackBufferPreference()).toEqual({ profile: 'auto' });
  });

  it('clamps custom target values and accepts string numbers', () => {
    expect(normalizeMonitorPlaybackBufferPreference({
      profile: 'custom',
      customTargetBufferMs: '150',
    })).toEqual({ profile: 'custom', customTargetBufferMs: 150 });
    expect(normalizeMonitorPlaybackBufferPreference({
      profile: 'custom',
      customTargetBufferMs: 20,
    })).toEqual({ profile: 'custom', customTargetBufferMs: 40 });
    expect(normalizeMonitorPlaybackBufferPreference({
      profile: 'custom',
      customTargetBufferMs: 900,
    })).toEqual({ profile: 'custom', customTargetBufferMs: 500 });
  });

  it('resolves auto to the existing adaptive defaults', () => {
    expect(resolveMonitorPlaybackBufferPolicy({ profile: 'auto' })).toEqual(DEFAULT_MONITOR_PLAYBACK_BUFFER_POLICY);
    expect(resolveMonitorPlaybackBufferPolicy({ profile: 'auto' }, { initialTargetMs: 140 })).toMatchObject({
      profile: 'auto',
      targetBufferMs: 80,
      initialTargetMs: 140,
    });
  });

  it('resolves custom to a fixed non-adaptive target', () => {
    expect(resolveMonitorPlaybackBufferPolicy({
      profile: 'custom',
      customTargetBufferMs: 160,
    })).toMatchObject({
      profile: 'custom',
      adaptive: false,
      targetBufferMs: 160,
      initialTargetMs: 160,
      minTargetMs: 160,
      maxTargetMs: 160,
    });
  });

  it('saves normalized preferences', () => {
    saveMonitorPlaybackBufferPreference({ profile: 'custom', customTargetBufferMs: 900 });
    expect(JSON.parse(window.localStorage.getItem(MONITOR_PLAYBACK_BUFFER_STORAGE_KEY) ?? '{}')).toEqual({
      profile: 'custom',
      customTargetBufferMs: 500,
    });
  });

  it('loads and saves bounded jitter seed values with TTL', () => {
    expect(normalizeMonitorPlaybackJitterSeed(null)).toBeNull();
    expect(normalizeMonitorPlaybackJitterSeed({ targetMs: 900, updatedAtMs: 1000 }, 2000)).toMatchObject({
      targetMs: 400,
    });
    expect(normalizeMonitorPlaybackJitterSeed({ targetMs: 120, updatedAtMs: 1000 }, 1000 + (31 * 60 * 1000))).toBeNull();

    saveMonitorPlaybackJitterSeed({
      targetMs: 130,
      p95Ms: 44,
      transport: 'rtc-data-audio',
      codec: 'opus',
      updatedAtMs: Date.now(),
    });
    expect(JSON.parse(window.localStorage.getItem(MONITOR_PLAYBACK_JITTER_SEED_STORAGE_KEY) ?? '{}')).toMatchObject({
      targetMs: 120,
      p95Ms: 44,
      transport: 'rtc-data-audio',
      codec: 'opus',
    });
    expect(loadMonitorPlaybackJitterSeed()).toMatchObject({ targetMs: 120 });
  });

  it('saves auto jitter seed from p95 recommendation instead of a stale max target', () => {
    expect(resolveMonitorPlaybackJitterSeedTargetMs({ targetMs: 220, p95Ms: 0 })).toBe(80);
    expect(resolveMonitorPlaybackJitterSeedTargetMs({ targetMs: 220, p95Ms: 28 })).toBe(100);
    expect(resolveMonitorPlaybackJitterSeedTargetMs({ targetMs: 140, p95Ms: null })).toBe(140);
  });
});
