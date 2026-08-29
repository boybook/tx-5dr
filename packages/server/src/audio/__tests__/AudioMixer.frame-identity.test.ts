import { describe, expect, it, vi } from 'vitest';
import { AudioMixer } from '../AudioMixer.js';
import { buildTrackId } from '../../transmission/TransmissionIntent.js';

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
    expect(mixer.getFrameSnapshot('frame-2', 2)?.tracks.get('b\u0000default')).toMatchObject({
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
      ['b\u0000default'],
    );
    expect(Array.from(cloned!.tracks.keys())).toEqual(['b\u0000default']);
    expect(mixer.getFrameSnapshot('frame-1', 1)?.tracks.has('a\u0000default')).toBe(true);
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

  it('keeps three streams from one operator distinct alongside another operator', async () => {
    const mixer = new AudioMixer(0);
    const frame = { frameId: 'frame-parallel', frameRevision: 1, slotId: 'slot-0' };
    const tracks = [
      { operatorId: 'a', streamId: 'lane-1', frequency: 1_200, amplitude: 0.1 },
      { operatorId: 'a', streamId: 'lane-2', frequency: 1_260, amplitude: 0.2 },
      { operatorId: 'a', streamId: 'lane-3', frequency: 1_320, amplitude: 0.3 },
      { operatorId: 'b', streamId: 'default', frequency: 1_500, amplitude: 0.4 },
    ];
    for (const track of tracks) {
      mixer.addOperatorAudio(
        track.operatorId,
        new Float32Array([track.amplitude, -track.amplitude]),
        12_000,
        0,
        `${track.operatorId}-${track.streamId}`,
        0,
        {
          ...frame,
          streamId: track.streamId,
          audioFrequencyHz: track.frequency,
        },
      );
    }

    const expectedTrackIds = tracks.map((track) => buildTrackId(track.operatorId, track.streamId));
    expect(Array.from(mixer.getFrameSnapshot(frame.frameId, frame.frameRevision)!.tracks.keys()))
      .toEqual(expectedTrackIds);

    const mixed = await mix(mixer, frame);
    expect(mixed?.operatorIds).toEqual(['a', 'b']);
    expect(mixed?.trackIds).toEqual(expectedTrackIds);
    expect(mixed?.tracks).toEqual(tracks.map((track) => ({
      operatorId: track.operatorId,
      streamId: track.streamId,
      trackId: buildTrackId(track.operatorId, track.streamId),
      audioFrequencyHz: track.frequency,
    })));
  });

  it('mixes three signals with calibrated linear gain, bounded peak and no sample-wise clipping', async () => {
    const mixer = new AudioMixer({
      mixingWindowMs: 0,
      multiSignalRmsBackoffDb: 6,
      multiSignalPeakCeiling: 0.95,
    });
    const frame = { frameId: 'frame-calibrated', frameRevision: 1, slotId: 'slot-0' };
    const sampleCount = 512;
    const sources = [
      Float32Array.from({ length: sampleCount }, (_, index) => 0.8 * Math.sin((2 * Math.PI * 7 * index) / sampleCount)),
      Float32Array.from({ length: sampleCount }, (_, index) => 0.8 * Math.sin((2 * Math.PI * 11 * index) / sampleCount + 0.3)),
      Float32Array.from({ length: sampleCount }, (_, index) => 0.8 * Math.sin((2 * Math.PI * 17 * index) / sampleCount + 0.7)),
    ];
    const streamIds = ['lane-1', 'lane-2', 'lane-3'];
    streamIds.forEach((streamId, index) => {
      mixer.addOperatorAudio('a', sources[index], 12_000, 0, streamId, 0, {
        ...frame,
        streamId,
        audioFrequencyHz: 1_200 + index * 60,
      });
    });

    const mixed = await mix(mixer, frame);
    const metrics = mixed!.mixMetrics!;
    expect(metrics).toMatchObject({
      trackCount: 3,
      peakBackoffApplied: false,
      centerFrequenciesHz: [1_200, 1_260, 1_320],
      minimumSpacingHz: 60,
    });
    expect(metrics.actualRms).toBeCloseTo(metrics.targetRms, 5);
    expect(metrics.peak).toBeLessThanOrEqual(0.950_001);
    expect(Array.from(mixed!.audioData).every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 0.950_001))
      .toBe(true);

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const expected = streamIds.reduce((sum, streamId, sourceIndex) => (
        sum + sources[sourceIndex][sampleIndex] * metrics.perTrackGain[buildTrackId('a', streamId)]
      ), 0) * metrics.finalLinearGain;
      expect(mixed!.audioData[sampleIndex]).toBeCloseTo(expected, 6);
    }
  });

  it('preserves a single track sample-for-sample', async () => {
    const mixer = new AudioMixer({
      mixingWindowMs: 0,
      multiSignalRmsBackoffDb: 6,
      multiSignalPeakCeiling: 0.95,
    });
    const frame = { frameId: 'frame-single', frameRevision: 1, slotId: 'slot-0' };
    const source = new Float32Array([-0.8, -0.25, 0, 0.4, 0.9]);
    mixer.addOperatorAudio('a', source, 12_000, 0, 'single', 0, {
      ...frame,
      streamId: 'default',
      audioFrequencyHz: 1_500,
    });

    const mixed = await mix(mixer, frame);
    expect(mixed?.audioData).toEqual(source);
    expect(mixed?.mixMetrics).toMatchObject({
      trackCount: 1,
      peakBackoffApplied: false,
      finalLinearGain: 1,
      perTrackGain: { [buildTrackId('a')]: 1 },
    });
    expect(mixed?.mixMetrics?.peak).toBeCloseTo(0.9, 6);
  });
});
