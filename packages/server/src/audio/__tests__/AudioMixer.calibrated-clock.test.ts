import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioMixer, type MixedAudio } from '../AudioMixer.js';

vi.mock('../../utils/audioUtils.js', () => ({
  resampleAudioProfessional: vi.fn(),
}));

const CALIBRATION_OFFSET_MS = 5_000;
const FRAME = { frameId: 'frame-1', frameRevision: 1, slotId: 'slot-0' };

describe('AudioMixer scheduled mixing on the calibrated clock', () => {
  let mixer: AudioMixer;
  let ready: MixedAudio[];
  const calibratedNow = () => Date.now() + CALIBRATION_OFFSET_MS;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    mixer = new AudioMixer({ mixingWindowMs: 100, now: calibratedNow });
    ready = [];
    mixer.on('mixedAudioReady', (mixed: MixedAudio) => ready.push(mixed));
    mixer.addOperatorAudio('op-1', new Float32Array(12_000).fill(0.1), 12_000, 0, 'req-1', 0, FRAME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the scheduled mix 50 ms before a calibrated playback target', async () => {
    const target = calibratedNow() + 1_000;
    mixer.scheduleFrameMixing({ frameId: FRAME.frameId, revision: FRAME.frameRevision }, target);

    await vi.advanceTimersByTimeAsync(949);
    expect(ready).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.playbackOffsetMs).toBe(0);
  });

  it('skips the waveform already elapsed since a calibrated playback start', async () => {
    const playbackStart = calibratedNow() - 250;
    mixer.scheduleFrameMixing(
      { frameId: FRAME.frameId, revision: FRAME.frameRevision },
      playbackStart,
      playbackStart,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.playbackOffsetMs).toBe(250);
    expect(ready[0]?.audioData.length).toBe(12_000 - 3_000);
  });
});
