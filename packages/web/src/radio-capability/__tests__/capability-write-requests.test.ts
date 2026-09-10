import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSMessageHandler, type WSClient } from '@tx5dr/core';
import { WSMessageType } from '@tx5dr/contracts';
import { CapabilityWriteRequests, CAPABILITY_WRITE_CONFIRM_TIMEOUT_MS } from '../CapabilityWriteRequests';

function fixture() {
  const port = Object.assign(new WSMessageHandler(), { send: vi.fn() });
  const requests = new CapabilityWriteRequests(port as unknown as WSClient);
  const result = (id: string, capabilityId: string, value: number) => port.handleRawMessage(JSON.stringify({
    type: WSMessageType.RADIO_CAPABILITY_CHANGED, id, timestamp: new Date().toISOString(),
    data: { id: capabilityId, value, supported: true, updatedAt: 2 },
  }));
  return { port, requests, result };
}
afterEach(() => { vi.useRealTimers(); });

describe('correlated capability write requests', () => {
  it('keeps payloads unchanged and requires the matching message and capability IDs', async () => {
    vi.useFakeTimers(); const { port, requests, result } = fixture();
    const completed = vi.fn(); const payload = { id: 'rf_power', value: 0.8, sessionId: 'session' };
    const pending = requests.write(payload).then(completed);
    const id = port.send.mock.calls[0][2];
    expect(port.send).toHaveBeenCalledWith(WSMessageType.WRITE_RADIO_CAPABILITY, payload, expect.any(String));
    result('another-request', payload.id, 0.1); result(id, 'af_gain', 0.5);
    await Promise.resolve(); expect(completed).not.toHaveBeenCalled();
    result(id, payload.id, 0.7); await pending;
    expect(completed).toHaveBeenCalledWith({ outcome: 'completed', state: { id: payload.id, value: 0.7, supported: true, updatedAt: 2 } });
    expect(port.listenerCount('rawMessage')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('routes out-of-order replies to their own pending operation', async () => {
    const { port, requests, result } = fixture();
    const a = requests.write({ id: 'rf_power', value: 0.3 }); const b = requests.write({ id: 'rf_power', value: 0.8 });
    expect(port.listenerCount('rawMessage')).toBe(1);
    result(port.send.mock.calls[1][2], 'rf_power', 0.7); expect((await b).outcome).toBe('completed');
    result(port.send.mock.calls[0][2], 'rf_power', 0.3); expect((await a).outcome).toBe('completed');
    expect(port.listenerCount('rawMessage')).toBe(0);
  });
  it('decodes a correlated rejection without rejecting an unrelated operation', async () => {
    const { port, requests } = fixture();
    const pending = requests.write({ id: 'rf_power', value: 0.9 });
    port.handleRawMessage(JSON.stringify({ type: WSMessageType.ERROR, timestamp: new Date().toISOString(), id: port.send.mock.calls[0][2], data: { message: 'Rejected' } }));
    expect(await pending).toEqual({ outcome: 'failed', error: 'Rejected' }); expect(port.listenerCount('rawMessage')).toBe(0);
  });
  it('expires without retrying or querying the radio', async () => {
    vi.useFakeTimers(); const { port, requests } = fixture(); const pending = requests.write({ id: 'rf_power', value: 0.9 });
    await vi.advanceTimersByTimeAsync(CAPABILITY_WRITE_CONFIRM_TIMEOUT_MS);
    expect((await pending).outcome).toBe('failed'); expect(port.send).toHaveBeenCalledOnce(); expect(port.listenerCount('rawMessage')).toBe(0);
  });
  it('returns subscriptions and pending timers to baseline across 100 lifetimes', async () => {
    vi.useFakeTimers(); const port = Object.assign(new WSMessageHandler(), { send: vi.fn() });
    for (let index = 0; index < 100; index++) {
      const requests = new CapabilityWriteRequests(port as unknown as WSClient); const pending = requests.write({ id: 'rf_power', value: 0.9 });
      requests.dispose(); expect(await pending).toEqual({ outcome: 'cancelled' });
    }
    expect(port.listenerCount('rawMessage')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
