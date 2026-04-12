import { describe, expect, it, vi } from 'vitest';

import { PluginIframeRequestGate } from '../PluginIframeRequestGate';

describe('PluginIframeRequestGate', () => {
  it('queues early requests until the host locks the page session', () => {
    const gate = new PluginIframeRequestGate<{ requestId: string; kind: string }>();
    const dispatch = vi.fn();

    expect(gate.dispatchOrQueue({ requestId: 'r1', kind: 'invoke' }, dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();

    const pendingRequests = gate.lock('session-1');
    expect(pendingRequests).toEqual([{ requestId: 'r1', kind: 'invoke' }]);
  });

  it('preserves request order while queued and dispatches immediately after lock', () => {
    const gate = new PluginIframeRequestGate<{ requestId: string }>();
    const dispatch = vi.fn();

    gate.dispatchOrQueue({ requestId: 'r1' }, dispatch);
    gate.dispatchOrQueue({ requestId: 'r2' }, dispatch);

    const pendingRequests = gate.lock('session-1');
    pendingRequests.forEach((request) => {
      dispatch(request, gate.getLockedPageSessionId());
    });

    expect(dispatch.mock.calls).toEqual([
      [{ requestId: 'r1' }, 'session-1'],
      [{ requestId: 'r2' }, 'session-1'],
    ]);

    expect(gate.dispatchOrQueue({ requestId: 'r3' }, dispatch)).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({ requestId: 'r3' }, 'session-1');
  });

  it('drops stale queued requests when the iframe session is reset', () => {
    const gate = new PluginIframeRequestGate<{ requestId: string }>();

    gate.dispatchOrQueue({ requestId: 'r1' }, vi.fn());
    gate.dispatchOrQueue({ requestId: 'r2' }, vi.fn());

    expect(gate.dropPending()).toEqual([{ requestId: 'r1' }, { requestId: 'r2' }]);
    expect(gate.lock('session-2')).toEqual([]);
  });
});
