import { describe, expect, it, vi } from 'vitest';
import { DigitalFrameCoordinator } from '../DigitalFrameCoordinator.js';

function createCoordinator() {
  let id = 0;
  return new DigitalFrameCoordinator({
    idFactory: () => `frame-${++id}`,
    physicalStartBudgetMs: 300,
    tailHoldMs: 500,
  });
}

function commitFrame(coordinator: DigitalFrameCoordinator, frameId: string): void {
  expect(coordinator.prepareFrameForHandover(frameId)?.phase).toBe('prepared');
  expect(coordinator.commitFrame(frameId)?.phase).toBe('committed');
}

describe('DigitalFrameCoordinator', () => {
  it('tombstones a pre-commit frame and rejects its late encode callback', () => {
    const coordinator = createCoordinator();
    const terminal = vi.fn();
    coordinator.on('terminal', terminal);

    const first = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'plugin', reason: 'initial', text: 'CQ A', decisionEpoch: 1 }],
    });
    coordinator.beginEncoding(first.frame!.frameId);

    const replacement = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'late-decode', reason: 'late decode', text: 'B A R-10', decisionEpoch: 2 }],
    });

    expect(first.frame?.frameId).toBe('frame-1');
    expect(replacement.frame?.frameId).toBe('frame-2');
    expect(coordinator.getFrame('frame-1')).toMatchObject({ phase: 'cancelled', superseded: true });
    expect(terminal).toHaveBeenCalledTimes(1);

    expect(coordinator.acceptEncodeResult({
      frameId: 'frame-1',
      operatorId: 'a',
      decisionEpoch: first.intents[0].decisionEpoch,
      revision: first.frame!.revision,
    })).toBe(false);
    expect(coordinator.getStaleCallbackDiscardCount()).toBe(1);
  });

  it('freezes multiple operators into one frame and becomes ready only after all encodes', () => {
    const coordinator = createCoordinator();
    const prepared = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [
        { operatorId: 'a', source: 'plugin', reason: 'slot', text: 'CQ A', decisionEpoch: 1 },
        { operatorId: 'b', source: 'plugin', reason: 'slot', text: 'CQ B', decisionEpoch: 1 },
      ],
    });
    const frame = prepared.frame!;
    coordinator.beginEncoding(frame.frameId);

    expect(coordinator.acceptEncodeResult({
      frameId: frame.frameId,
      operatorId: 'a',
      decisionEpoch: prepared.intents[0].decisionEpoch,
      revision: frame.revision,
    })).toBe(true);
    expect(coordinator.getFrame(frame.frameId)?.phase).toBe('encoding');

    expect(coordinator.acceptEncodeResult({
      frameId: frame.frameId,
      operatorId: 'b',
      decisionEpoch: prepared.intents[1].decisionEpoch,
      revision: frame.revision,
    })).toBe(true);
    expect(coordinator.getFrame(frame.frameId)).toMatchObject({
      phase: 'ready',
      participantOperatorIds: ['a', 'b'],
    });
  });

  it('restarts an on-air frame only when a complete replacement fits the slot', () => {
    const coordinator = createCoordinator();
    const first = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'plugin', reason: 'initial', decisionEpoch: 1 }],
    });
    const frame = first.frame!;
    coordinator.beginEncoding(frame.frameId);
    coordinator.acceptEncodeResult({
      frameId: frame.frameId,
      operatorId: 'a',
      decisionEpoch: first.intents[0].decisionEpoch,
      revision: frame.revision,
    });
    commitFrame(coordinator, frame.frameId);
    coordinator.markOnAir(frame.frameId);

    const restart = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'late-decode', reason: 'correction', decisionEpoch: 2 }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
    });
    expect(restart.action).toBe('restart-current');
    expect(restart.frame?.frameId).toBe('frame-2');
    expect(coordinator.getFrame(frame.frameId)).toMatchObject({ phase: 'on_air', superseded: false });
    expect(coordinator.getPhysicalFrameForSlot('slot-1')?.frameId).toBe(frame.frameId);
    expect(coordinator.getCandidateFrameForSlot('slot-1')?.frameId).toBe('frame-2');
  });

  it('defers a late correction when a complete frame cannot fit', () => {
    const coordinator = createCoordinator();
    const first = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'plugin', reason: 'initial', decisionEpoch: 1 }],
    });
    const frame = first.frame!;
    coordinator.beginEncoding(frame.frameId);
    coordinator.acceptEncodeResult({
      frameId: frame.frameId,
      operatorId: 'a',
      decisionEpoch: first.intents[0].decisionEpoch,
      revision: frame.revision,
    });
    commitFrame(coordinator, frame.frameId);
    coordinator.markOnAir(frame.frameId);

    const deferred = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'late-decode', reason: 'too late', decisionEpoch: 2 }],
      nowMs: 2_000,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
    });
    expect(deferred.action).toBe('defer-next-slot');
    expect(deferred.frame?.frameId).toBe(frame.frameId);
    expect(coordinator.getFrame(frame.frameId)).toMatchObject({ phase: 'on_air', superseded: false });
  });

  it('rechecks the complete-frame budget after encoding and mixing delays', () => {
    const coordinator = createCoordinator();
    const prepared = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'late-decode', reason: 'correction', decisionEpoch: 1 }],
      nowMs: 0,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
    });

    expect(coordinator.hasCompleteFrameBudget(prepared.frame!.frameId, 1_000, 12_640)).toBe(true);
    expect(coordinator.hasCompleteFrameBudget(prepared.frame!.frameId, 2_000, 12_640)).toBe(false);
  });

  it('accounts for the elapsed waveform when enabling TX mid-slot', () => {
    const coordinator = createCoordinator();
    const prepared = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'operator-edit', reason: 'TX enabled mid-slot', decisionEpoch: 1 }],
      nowMs: 5_000,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
      playbackStartMs: 500,
    });

    expect(coordinator.getPlaybackOffsetMs(prepared.frame!.frameId, 5_000)).toBe(4_500);
    expect(coordinator.hasCompleteFrameBudget(prepared.frame!.frameId, 5_000, 8_140)).toBe(true);
  });

  it('emits terminal exactly once and defers ordinary stop after commit', () => {
    const coordinator = createCoordinator();
    const terminal = vi.fn();
    coordinator.on('terminal', terminal);
    const prepared = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'plugin', reason: 'initial', decisionEpoch: 1 }],
    });
    const frame = prepared.frame!;
    coordinator.beginEncoding(frame.frameId);
    coordinator.acceptEncodeResult({
      frameId: frame.frameId,
      operatorId: 'a',
      decisionEpoch: prepared.intents[0].decisionEpoch,
      revision: frame.revision,
    });
    commitFrame(coordinator, frame.frameId);

    expect(coordinator.requestStrategyStop('a', 'strategy complete')).toBe('deferred');
    coordinator.markOnAir(frame.frameId);
    coordinator.completeFrame(frame.frameId, 'audio complete');
    coordinator.completeFrame(frame.frameId, 'duplicate callback');
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('derives a ready replacement from retained encoded participants', () => {
    const coordinator = createCoordinator();
    const prepared = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [
        { operatorId: 'a', source: 'plugin', reason: 'mixed frame', text: 'CQ A', decisionEpoch: 1 },
        { operatorId: 'b', source: 'plugin', reason: 'mixed frame', text: 'CQ B', decisionEpoch: 1 },
      ],
      playbackStartMs: 500,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
    });
    coordinator.beginEncoding(prepared.frame!.frameId);
    prepared.intents.forEach((intent) => coordinator.acceptEncodeResult({
      frameId: prepared.frame!.frameId,
      operatorId: intent.operatorId!,
      decisionEpoch: intent.decisionEpoch,
      revision: prepared.frame!.revision,
    }));
    commitFrame(coordinator, prepared.frame!.frameId);
    coordinator.markOnAir(prepared.frame!.frameId);

    const removal = coordinator.prepareParticipantRemoval(
      prepared.frame!.frameId,
      'a',
      'operator a stopped',
    );

    expect(removal).toMatchObject({
      action: 'replace-current',
      remainingOperatorIds: ['b'],
      frame: {
        frameId: 'frame-2',
        revision: 2,
        phase: 'ready',
        participantOperatorIds: ['b'],
      },
    });
    expect(coordinator.getFrame(prepared.frame!.frameId)).toMatchObject({
      phase: 'on_air',
      superseded: false,
    });
    expect(coordinator.getReplacedFrameId('frame-2')).toBe(prepared.frame!.frameId);
    expect(coordinator.getPlaybackOffsetMs('frame-2', 4_500)).toBe(4_000);
  });

  it('tombstones unfinished frames when a new slot begins', () => {
    const coordinator = createCoordinator();
    const prepared = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'plugin', reason: 'slow encode', text: 'CQ A', decisionEpoch: 1 }],
    });
    coordinator.beginEncoding(prepared.frame!.frameId);

    const cancelled = coordinator.cancelPreCommitFramesOutsideSlot('slot-2', 'slot boundary');
    expect(cancelled).toMatchObject([{ frameId: prepared.frame!.frameId, phase: 'cancelled' }]);
    expect(coordinator.acceptEncodeResult({
      frameId: prepared.frame!.frameId,
      operatorId: 'a',
      decisionEpoch: prepared.intents[0].decisionEpoch,
      revision: prepared.frame!.revision,
    })).toBe(false);
  });

  it('keeps the physical slot owner when a replacement candidate fails', () => {
    const coordinator = createCoordinator();
    const first = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'plugin', reason: 'initial', text: 'CQ A', decisionEpoch: 1 }],
      playbackStartMs: 500,
    });
    coordinator.beginEncoding(first.frame!.frameId);
    coordinator.acceptEncodeResult({
      frameId: first.frame!.frameId,
      operatorId: 'a',
      decisionEpoch: first.intents[0].decisionEpoch,
      revision: first.frame!.revision,
    });
    commitFrame(coordinator, first.frame!.frameId);
    coordinator.markOnAir(first.frame!.frameId);

    const failed = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'late-decode', reason: 'first correction', text: 'B A R-10', decisionEpoch: 2 }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
      playbackStartMs: 500,
    });
    coordinator.beginEncoding(failed.frame!.frameId);
    coordinator.acceptEncodeResult({
      frameId: failed.frame!.frameId,
      operatorId: 'a',
      decisionEpoch: failed.intents[0].decisionEpoch,
      revision: failed.frame!.revision,
    });
    coordinator.prepareFrameForHandover(failed.frame!.frameId);
    coordinator.deferFrame(failed.frame!.frameId, 'candidate mix failed');

    expect(coordinator.getPhysicalFrameForSlot('slot-1')).toMatchObject({
      frameId: first.frame!.frameId,
      phase: 'on_air',
    });
    expect(coordinator.getCandidateFrameForSlot('slot-1')).toBeNull();

    const retry = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'late-decode', reason: 'retry correction', text: 'B A RR73', decisionEpoch: 3 }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
      playbackStartMs: 500,
    });
    expect(retry).toMatchObject({ action: 'restart-current', frame: { revision: 3 } });
  });

  it('cancels every pre-commit frame without touching the physical owner', () => {
    const coordinator = createCoordinator();
    const physical = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'plugin', reason: 'initial', text: 'CQ A', decisionEpoch: 1 }],
      playbackStartMs: 500,
    });
    coordinator.beginEncoding(physical.frame!.frameId);
    coordinator.acceptEncodeResult({
      frameId: physical.frame!.frameId,
      operatorId: 'a',
      decisionEpoch: physical.intents[0].decisionEpoch,
      revision: physical.frame!.revision,
    });
    commitFrame(coordinator, physical.frame!.frameId);
    coordinator.markOnAir(physical.frame!.frameId);

    const candidate = coordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{ operatorId: 'a', source: 'operator-edit', reason: 'edit', text: 'B A RR73', decisionEpoch: 2 }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
      playbackStartMs: 500,
    });
    coordinator.beginEncoding(candidate.frame!.frameId);

    expect(coordinator.cancelAllPreCommitFrames('mode change')).toMatchObject([
      { frameId: candidate.frame!.frameId, phase: 'cancelled' },
    ]);
    expect(coordinator.getPhysicalFrameForSlot('slot-1')).toMatchObject({
      frameId: physical.frame!.frameId,
      phase: 'on_air',
    });
  });
});
