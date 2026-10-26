import { describe, expect, it, vi } from 'vitest';
import { SyncBusyError, SyncOperationGate } from './sync-operation-gate.js';

describe('provider operation gate', () => {
  it('rejects competing manual work, awaits automatic work, and isolates callsigns and providers', async () => {
    const gate = new SyncOperationGate();
    let release!: () => void;
    const first = gate.run('bg5drb', () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const queued = vi.fn(async () => 'automatic');
    const automatic = gate.run('BG5DRB/P', queued, true);
    await expect(gate.run('BG5DRB', async () => 'manual')).rejects.toBeInstanceOf(SyncBusyError);
    expect(() => gate.assertIdle('BG5DRB')).toThrow(SyncBusyError);
    expect(queued).not.toHaveBeenCalled();
    await expect(gate.run('JA1ABC', async () => 'other callsign')).resolves.toBe('other callsign');
    await expect(new SyncOperationGate().run('BG5DRB', async () => 'other provider')).resolves.toBe('other provider');
    release(); await first;
    await expect(automatic).resolves.toBe('automatic');
    expect(gate.isBusy('BG5DRB')).toBe(false);
  });
  it('releases a failed operation and does not poison the automatic tail', async () => {
    const gate = new SyncOperationGate();
    const failed = gate.run('BG5DRB', async () => { throw new Error('remote failed'); });
    const next = gate.run('BG5DRB', async () => 'next', true);
    await expect(failed).rejects.toThrow('remote failed');
    await expect(next).resolves.toBe('next');
    expect(gate.isBusy('BG5DRB')).toBe(false);
  });
});
