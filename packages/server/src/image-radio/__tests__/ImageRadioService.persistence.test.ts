import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import type { SstvTxStartCommand } from '@tx5dr/contracts';
import { ImageRadioService } from '../ImageRadioService.js';

function harness(available: boolean) {
  const audio = Object.assign(new EventEmitter(), { openDeterministicPlayback: vi.fn() });
  const physical = { getSnapshot: vi.fn(() => ({ phase: 'idle' })), requestLease: vi.fn() };
  const paper = { initialize: vi.fn(async () => undefined), reset: vi.fn(async () => undefined), getSession: () => null };
  const codec = { getAvailability: () => ({ available: true }), load: vi.fn() };
  const artifacts = { initialize: vi.fn() };
  const service = new ImageRadioService(audio as never, artifacts as never, {} as never, physical as never,
    () => null, () => undefined, undefined, codec as never, paper as never, () => true,
    () => ({ available, stores: [{ store: 'artifacts', state: available ? 'ready' : 'unavailable', reason: 'io_error', retainedRecords: 0, rejectedRecords: 0 }] }));
  return { service, audio, physical, paper, codec, artifacts };
}

describe('image service failure boundary', () => {
  it.each(['sstv', 'fax'] as const)('does not fail mode startup or claim resources when persistence is unavailable (%s)', async family => {
    const h = harness(false);
    await expect(h.service.start(family)).resolves.toBeUndefined();
    expect(h.service.getStatus()).toMatchObject({ serviceState: 'unavailable', capability: { available: true }, persistence: { available: false } });
    expect(h.codec.load).not.toHaveBeenCalled();
    expect(h.audio.listenerCount('audioData')).toBe(0);
    expect(h.artifacts.initialize).not.toHaveBeenCalled();
    expect(h.physical.requestLease).not.toHaveBeenCalled();
    expect(await h.service.startSstvTx({ requestId: 'request' } as SstvTxStartCommand)).toEqual({ requestId: 'request', accepted: false, errorCode: 'IMAGE_PERSISTENCE_UNAVAILABLE' });
    expect(h.audio.openDeterministicPlayback).not.toHaveBeenCalled();
    expect(h.physical.getSnapshot).not.toHaveBeenCalled();
    // The same serializable status is used for HTTP reads and WS reconnect snapshots.
    expect(JSON.parse(JSON.stringify(h.service.getStatus())).persistence.available).toBe(false);
  });

  it('contains paper directory errors and removes listeners during cleanup', async () => {
    const h = harness(true);
    h.paper.initialize.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(h.service.start('fax')).resolves.toBeUndefined();
    expect(h.service.getStatus().serviceState).toBe('unavailable');
    expect(h.audio.listenerCount('audioData')).toBe(0);
    expect(h.codec.load).not.toHaveBeenCalled();
    h.paper.reset.mockRejectedValueOnce(new Error('reset denied'));
    await expect(h.service.stop()).resolves.toBeUndefined();
  });
});
