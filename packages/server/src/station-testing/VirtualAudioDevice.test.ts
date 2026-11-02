import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualAudioDevice } from './VirtualAudioDevice.js';

afterEach(() => { vi.useRealTimers(); });
describe('external PCM device', () => {
  it('consumes asynchronously at the device rate and keeps a bounded FIFO', async () => {
    vi.useFakeTimers();
    const consumed = vi.fn();
    const device = new VirtualAudioDevice(() => new Float32Array(120), () => Date.now());
    device.openStream({ deviceId: 0, nChannels: 1 }, null, 0x10, 12000, 120, 'test', null, consumed);
    device.start(); device.write(Buffer.alloc(480));
    expect(consumed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(consumed).toHaveBeenCalledTimes(1);
    device.faults.stall = true;
    for (let i = 0; i < 100; i++) device.write(Buffer.alloc(480));
    expect(() => device.write(Buffer.alloc(480))).toThrow('FIFO full');
    await vi.advanceTimersByTimeAsync(100);
    expect(consumed).toHaveBeenCalledTimes(1);
    device.closeStream();
    await vi.advanceTimersByTimeAsync(100);
    expect(consumed).toHaveBeenCalledTimes(1);
  });
  it('delivers device PCM and reports loss without synthesizing consumption', async () => {
    vi.useFakeTimers();
    const input = vi.fn(), failed = vi.fn();
    const device = new VirtualAudioDevice((_at, _rate, n) => new Float32Array(n).fill(0.25), () => Date.now());
    device.openStream(null, { deviceId: 0, nChannels: 1 }, 0x2, 12000, 120, 'input', input, null, undefined, failed);
    device.start(); await vi.advanceTimersByTimeAsync(10);
    expect(input).toHaveBeenCalledTimes(1);
    expect((input.mock.calls[0]![0] as Buffer).readInt16LE(0)).toBe(8192);
    device.faults.disconnected = true; await vi.advanceTimersByTimeAsync(10);
    expect(failed).toHaveBeenCalledOnce(); expect(device.isStreamRunning()).toBe(false);
    device.closeStream();
  });
});
