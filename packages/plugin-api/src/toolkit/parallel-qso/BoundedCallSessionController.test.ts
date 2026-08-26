import { describe, expect, it } from 'vitest';
import { BoundedCallSessionController } from './BoundedCallSessionController.js';

describe('BoundedCallSessionController', () => {
  it('counts only acknowledged calls and bounds one selected batch', () => {
    const session = new BoundedCallSessionController();
    session.arm({ authorizationId: 'auth-1', maxAttempts: 6, capacity: 3 });
    expect(session.onPhysicalCallSuccess()).toBe(true);
    expect(session.successfulCalls).toBe(1);
    expect(session.beginCollecting('slot-1')).toBe(true);
    expect(session.beginCollecting('slot-2')).toBe(false);
    session.activateBatch(['A', 'B', 'C', 'D']);
    expect(session.state).toBe('batch-active');
    expect(session.selectedTargetKeys).toEqual(['A', 'B', 'C']);
    expect(session.beginCollecting('slot-1')).toBe(true);
    expect(session.beginCollecting('slot-2')).toBe(false);
    expect(session.onPhysicalCallSuccess()).toBe(false);
  });

  it('round trips checkpoints and records no-response completion', () => {
    const session = new BoundedCallSessionController();
    session.arm({ authorizationId: 'auth-2', maxAttempts: 2, capacity: 1 });
    session.onPhysicalCallSuccess();
    session.onPhysicalCallSuccess();
    const checkpoint = session.checkpoint();
    session.finishNoResponse();
    expect(session.state).toBe('no-response');
    session.restore(checkpoint);
    expect(session.attemptsExhausted).toBe(true);
    expect(session.state).toBe('calling');
  });
});
