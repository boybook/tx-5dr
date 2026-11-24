// Characterization tests for lesson TX-11 (docs/proposals/plugin-kernel/ft8-lessons.md):
// retained frames survive slot-cache clears and cache-cap pruning; once
// released they become ordinary cache entries again. The pipeline-level
// lifecycle (retain at committed/on_air/draining, release at terminal) is in
// subsystems/__tests__/TransmissionPipeline.lessons.test.ts.
import { describe, expect, it } from 'vitest';
import { FrameAudioRepository } from '../FrameAudioRepository.js';

function put(repository: FrameAudioRepository, frameId: string): void {
  repository.putTrack(
    { frameId, revision: 1, slotId: 'slot-0' },
    {
      operatorId: 'operator-a',
      streamId: 'default',
      trackId: 'operator-a\u0000default',
      audioFrequencyHz: 1_500,
      audioData: new Float32Array(4),
      sampleRate: 12_000,
      slotStartMs: 0,
      requestId: `${frameId}-request`,
      encodedAt: 0,
    },
    0,
  );
}

const has = (repository: FrameAudioRepository, frameId: string) => (
  repository.getSnapshot({ frameId, revision: 1 }) !== null
);

describe('FrameAudioRepository retention (TX-11)', () => {
  it('prunes the oldest unretained frames at the cap but never a retained frame', () => {
    const repository = new FrameAudioRepository(2);
    put(repository, 'on-air');
    repository.retain({ frameId: 'on-air', revision: 1 });

    put(repository, 'a');
    put(repository, 'b');
    put(repository, 'c');

    expect(has(repository, 'on-air')).toBe(true);
    expect(has(repository, 'a')).toBe(false);
    expect(has(repository, 'b')).toBe(false);
    expect(has(repository, 'c')).toBe(true);
  });

  it('clears only unretained frames at a slot boundary', () => {
    const repository = new FrameAudioRepository();
    put(repository, 'draining');
    put(repository, 'stale');
    repository.retain({ frameId: 'draining', revision: 1 });

    expect(repository.clearUnretained()).toBe(1);

    expect(has(repository, 'draining')).toBe(true);
    expect(has(repository, 'stale')).toBe(false);
  });

  it('makes a released frame prunable and clearable again', () => {
    const repository = new FrameAudioRepository(2);
    put(repository, 'finished');
    repository.retain({ frameId: 'finished', revision: 1 });
    put(repository, 'next-1');
    expect(repository.clearUnretained()).toBe(1);
    expect(has(repository, 'finished')).toBe(true);

    repository.release({ frameId: 'finished', revision: 1 });
    put(repository, 'next-2');
    put(repository, 'next-3');

    // Once released, the oldest frame is pruned at the cap like any other.
    expect(has(repository, 'finished')).toBe(false);
    expect(has(repository, 'next-2')).toBe(true);
    expect(has(repository, 'next-3')).toBe(true);
    expect(repository.clearUnretained()).toBe(2);
  });
});
