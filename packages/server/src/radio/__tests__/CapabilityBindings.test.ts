import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityState } from '@tx5dr/contracts';
import { RadioCapabilityManager } from '../RadioCapabilityManager.js';
import { RadioConnectionType } from '../connections/IRadioConnection.js';
import type { CapabilityDefinition, RadioCapabilityBindings } from '../capabilities/types.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const state = (value: number): Omit<CapabilityState, 'id' | 'updatedAt'> => ({ supported: true, availability: 'available', value });
function definition(id = 'level', updateMode: 'event' | 'polling' = 'event'): CapabilityDefinition {
  return { id, descriptor: { id, category: 'audio', valueType: 'number', range: { min: 0, max: 100 },
    readable: true, writable: true, updateMode, pollIntervalMs: updateMode === 'polling' ? 10_000 : undefined,
    labelI18nKey: 'test.level', hasSurfaceControl: false, sessionId: 'session' },
    probeSupport: async () => ({ supported: true, source: 'backend-declared' }),
    readState: vi.fn(async () => state(7)), write: vi.fn(async () => ({ value: 9 })),
  };
}
function connection(definitions: CapabilityDefinition[], dispose = vi.fn()) {
  const bindings: RadioCapabilityBindings = { definitions, groups: [], subscribe: () => dispose };
  return { getType: () => RadioConnectionType.TCI, isConnected: () => true,
    getCapabilityBindings: () => bindings, isCriticalOperationActive: () => false } as never;
}

describe('connection capability bindings', () => {
  it('uses one fallback timer and no timer for event bindings', async () => {
    vi.useFakeTimers();
    const definitions = [definition('one', 'polling'), definition('two', 'polling'), definition('event')];
    const dispose = vi.fn();
    const manager = new RadioCapabilityManager();
    await manager.onConnected(connection(definitions, dispose));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(definitions[0].readState).toHaveBeenCalledTimes(2);
    expect(definitions[1].readState).toHaveBeenCalledTimes(2);
    expect(definitions[2].readState).toHaveBeenCalledTimes(1);
    manager.setPTTActive(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(definitions[0].readState).toHaveBeenCalledTimes(2);
    manager.onDisconnected();
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a late read from the previous connection', async () => {
    const manager = new RadioCapabilityManager();
    let resolve!: (value: ReturnType<typeof state>) => void;
    const old = definition();
    old.readState = async (_conn, force) => force ? new Promise((done) => { resolve = done; }) : state(7);
    await manager.onConnected(connection([old]));
    const refresh = manager.refreshAll();
    manager.onDisconnected();
    const next = definition(); next.readState = async () => state(2);
    await manager.onConnected(connection([next]));
    resolve(state(99)); await refresh;
    expect(manager.getCapabilityStates().find((item) => item.id === 'level')?.value).toBe(2);
    manager.onDisconnected();
  });

  it('rejects read-only writes even if a handler exists, and detaches snapshots', async () => {
    const manager = new RadioCapabilityManager();
    const d = definition(); d.descriptor.writable = false;
    await manager.onConnected(connection([d]));
    await expect(manager.writeCapability('level', 3)).rejects.toThrow(/read-only/);
    expect(d.write).not.toHaveBeenCalled();
    const snapshot = manager.getCapabilitySnapshot();
    snapshot.capabilities.find((item) => item.id === 'level')!.value = 999;
    snapshot.descriptors.find((item) => item.id === 'level')!.range!.max = 999;
    expect(manager.getCapabilityStates().find((item) => item.id === 'level')!.value).toBe(7);
    expect(manager.getCapabilityDescriptors().find((item) => item.id === 'level')!.range!.max).toBe(100);
    manager.onDisconnected();
  });
});
