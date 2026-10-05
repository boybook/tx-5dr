import { afterEach, describe, expect, it, vi } from 'vitest';
import { HamlibNativeMonitor, nativeOperationBudget } from '../HamlibNativeMonitor.js';

afterEach(() => { vi.useRealTimers(); });
describe('HamlibNativeMonitor', () => {
  it('keeps unresolved native activity visible and refuses later I/O after a timeout', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const monitor = new HamlibNativeMonitor(() => undefined, vi.fn(), failed);
    let release!: () => void;
    const call = monitor.run('getFrequency', () => new Promise<void>(resolve => { release = resolve; }));
    const assertion = expect(call).rejects.toMatchObject({ context: { hamlibHostFatal: true } });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(monitor.activities).toHaveLength(1);
    const write = vi.fn();
    await expect(monitor.run('setPtt', write)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(monitor.activities).toHaveLength(0);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(() => monitor.assertUsable()).toThrow();
  });

  it('does not poison the host on a settled ordinary device failure', async () => {
    const failed = vi.fn();
    const monitor = new HamlibNativeMonitor(() => undefined, vi.fn(), failed);
    await expect(monitor.run('getLevel', () => Promise.reject(new Error('unsupported level')))).rejects.toThrow('unsupported level');
    expect(monitor.activities).toHaveLength(0);
    expect(failed).not.toHaveBeenCalled();
    expect(() => monitor.assertUsable()).not.toThrow();
  });

  it('honors backend retry budgets and longer power operations', () => {
    expect(nativeOperationBudget('getFrequency', [])).toBe(5000);
    expect(nativeOperationBudget('getFrequency', [], undefined, { timeout: 3000, retry: 3 })).toBe(13000);
    expect(nativeOperationBudget('setPowerstat', [1])).toBe(20000);
    expect(nativeOperationBudget('setPowerstat', [0])).toBe(8000);
    expect(nativeOperationBudget('getFrequency', [], { type: 'serial', serial: { path: 'dummy', rigModel: 1, backendConfig: { timeout: '10000', retry: '2' } } })).toBe(31000);
  });
});
