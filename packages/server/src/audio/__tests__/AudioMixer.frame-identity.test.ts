import { describe, expect, it, vi } from 'vitest';
import { AudioMixer } from '../AudioMixer.js';

const resampleDeferred = vi.hoisted(() => vi.fn());
vi.mock('../../utils/audioUtils.js', () => ({
  resampleAudioProfessional: resampleDeferred,
}));

describe('AudioMixer frame identity', () => {
  async function mix(
    mixer: AudioMixer,
    frame: { frameId: string; frameRevision: number },
    offsetMs = 0,
  ) {
    const snapshot = mixer.getFrameSnapshot(frame.frameId, frame.frameRevision);
    expect(snapshot).not.toBeNull();
    return mixer.mixFrame(snapshot!, offsetMs);
  }

  it('never relabels an old operator track into a replacement mixed frame', async () => {
    const mixer = new AudioMixer(0);
    const firstFrame = { frameId: 'frame-1', frameRevision: 1, slotId: 'slot-0' };
    mixer.addOperatorAudio('a', new Float32Array([0.1, 0.1]), 12_000, 1, 'a-1', 0, firstFrame);
    mixer.addOperatorAudio('b', new Float32Array([0.2, 0.2]), 12_000, 1, 'b-1', 0, firstFrame);
    await expect(mix(mixer, firstFrame)).resolves.toMatchObject({
      operatorIds: ['a', 'b'],
      frameId: 'frame-1',
      frameRevision: 1,
    });

    const replacementFrame = { frameId: 'frame-2', frameRevision: 2, slotId: 'slot-0' };
    mixer.addOperatorAudio('a', new Float32Array([0.3, 0.3]), 12_000, 1, 'a-2', 0, replacementFrame);
    await expect(mix(mixer, replacementFrame)).resolves.toMatchObject({
      operatorIds: ['a'],
      frameId: 'frame-2',
      frameRevision: 2,
    });

    mixer.addOperatorAudio('b', new Float32Array([0.4, 0.4]), 12_000, 1, 'b-2', 0, replacementFrame);
    await expect(mix(mixer, replacementFrame)).resolves.toMatchObject({
      operatorIds: ['a', 'b'],
      frameId: 'frame-2',
      frameRevision: 2,
    });
  });

  it('freezes frame identity while an asynchronous resample is pending', async () => {
    let resolveResample!: (samples: Float32Array) => void;
    resampleDeferred.mockImplementationOnce(() => new Promise<Float32Array>((resolve) => {
      resolveResample = resolve;
    }));

    const mixer = new AudioMixer(0);
    mixer.addOperatorAudio(
      'a',
      new Float32Array([0.1, 0.1]),
      6_000,
      1,
      'a-1',
      10,
      { frameId: 'frame-1', frameRevision: 1, slotId: 'slot-0' },
    );
    mixer.addOperatorAudio(
      'b',
      new Float32Array([0.15, 0.15, 0.15, 0.15]),
      12_000,
      1,
      'b-1',
      10,
      { frameId: 'frame-1', frameRevision: 1, slotId: 'slot-0' },
    );
    const firstSnapshot = mixer.getFrameSnapshot('frame-1', 1)!;
    const mixing = mixer.mixFrame(firstSnapshot);
    await vi.waitFor(() => expect(resampleDeferred).toHaveBeenCalledTimes(1));

    mixer.addOperatorAudio(
      'a',
      new Float32Array([0.2, 0.2]),
      12_000,
      1,
      'a-2',
      20,
      { frameId: 'frame-2', frameRevision: 2, slotId: 'slot-0' },
    );
    resolveResample(new Float32Array([0.3, 0.3]));

    await expect(mixing).resolves.toMatchObject({
      operatorIds: ['a', 'b'],
      frameId: 'frame-1',
      frameRevision: 1,
      txDialShiftHz: 10,
    });
  });

  it('clears only the cancelled frame tracks when a newer frame is cached', () => {
    const mixer = new AudioMixer(0);
    mixer.addOperatorAudio('a', new Float32Array([0.1]), 12_000, 1, 'a-1', 0, {
      frameId: 'frame-1', frameRevision: 1, slotId: 'slot-0',
    });
    mixer.addOperatorAudio('b', new Float32Array([0.2]), 12_000, 1, 'b-2', 0, {
      frameId: 'frame-2', frameRevision: 2, slotId: 'slot-0',
    });

    expect(mixer.clearFrame('frame-1', 1)).toBe(1);
    expect(mixer.getFrameSnapshot('frame-1', 1)).toBeNull();
    expect(mixer.getFrameSnapshot('frame-2', 2)?.tracks.get('b')).toMatchObject({
      operatorId: 'b',
    });
  });

  it('rebinds retained encoded tracks without copying a removed participant into the mix', async () => {
    const mixer = new AudioMixer(0);
    const firstFrame = { frameId: 'frame-1', frameRevision: 1, slotId: 'slot-0' };
    mixer.addOperatorAudio('a', new Float32Array([0.1, 0.1]), 12_000, 1, 'a-1', 0, firstFrame);
    mixer.addOperatorAudio('b', new Float32Array([0.2, 0.2]), 12_000, 1, 'b-1', 0, firstFrame);

    const cloned = mixer.cloneFrameTracks(
      { frameId: 'frame-1', frameRevision: 1 },
      { frameId: 'frame-2', frameRevision: 2, slotId: 'slot-0' },
      ['b'],
    );
    expect(Array.from(cloned!.tracks.keys())).toEqual(['b']);
    expect(mixer.getFrameSnapshot('frame-1', 1)?.tracks.has('a')).toBe(true);
    await expect(mixer.mixFrame(cloned!)).resolves.toMatchObject({
      operatorIds: ['b'],
      frameId: 'frame-2',
      frameRevision: 2,
    });
  });

  it('restores the retained frame identity after cancelling a partially encoded replacement', async () => {
    const mixer = new AudioMixer(0);
    mixer.addOperatorAudio('b', new Float32Array([0.2, 0.2]), 12_000, 1, 'b-1', 0, {
      frameId: 'frame-1', frameRevision: 1, slotId: 'slot-0',
    });
    mixer.addOperatorAudio('a', new Float32Array([0.3, 0.3]), 12_000, 1, 'a-2', 0, {
      frameId: 'frame-2', frameRevision: 2, slotId: 'slot-0',
    });

    expect(mixer.clearFrame('frame-2', 2)).toBe(1);
    await expect(mix(mixer, { frameId: 'frame-1', frameRevision: 1 })).resolves.toMatchObject({
      operatorIds: ['b'],
      frameId: 'frame-1',
      frameRevision: 1,
    });
  });

  it('starts a mid-slot frame at the requested waveform offset', async () => {
    const mixer = new AudioMixer(0);
    mixer.addOperatorAudio(
      'a',
      new Float32Array([1, 2, 3, 4, 5]),
      1_000,
      0,
      'a-1',
      0,
      { frameId: 'frame-mid-slot', frameRevision: 1, slotId: 'slot-0' },
    );

    const mixed = await mix(mixer, { frameId: 'frame-mid-slot', frameRevision: 1 }, 2);
    expect(mixed?.audioData).toEqual(new Float32Array([3, 4, 5]));
    expect(mixed?.duration).toBeCloseTo(0.003, 6);
    expect(mixed?.playbackOffsetMs).toBe(2);
  });
});
