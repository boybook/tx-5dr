import { describe, expect, it } from 'vitest';
import { resolveExistingMonitorStart } from '../useAudioMonitorPlayback';

describe('useAudioMonitorPlayback helpers', () => {
  it('reuses the pending start promise while playback is initializing', async () => {
    const pending = Promise.resolve<'rtc-data-audio'>('rtc-data-audio');

    const result = resolveExistingMonitorStart(false, null, true, pending);

    expect(result).toBe(pending);
    await expect(result).resolves.toBe('rtc-data-audio');
  });

  it('returns the active transport when playback is already running', () => {
    expect(resolveExistingMonitorStart(true, 'ws-compat', false, null)).toBe('ws-compat');
  });

  it('throws if playback is initializing without a tracked promise', () => {
    expect(() => resolveExistingMonitorStart(false, null, true, null)).toThrow(
      'Realtime playback is already initializing',
    );
  });
});
