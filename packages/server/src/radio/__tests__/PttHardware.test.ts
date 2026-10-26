import { SerialPort } from 'serialport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PttHardware } from '../PttHardware.js';

// Keep SerialPortStream's real flag defaults; replace only the OS binding.
function createBindingPort() {
  const port = {
    isOpen: true,
    set: vi.fn(async (_signals: { dtr: boolean; rts: boolean }) => undefined),
    close: vi.fn(async () => { port.isOpen = false; }),
  };
  return port;
}

describe('PttHardware control lines', () => {
  let port: ReturnType<typeof createBindingPort>;

  beforeEach(() => {
    port = createBindingPort();
    vi.spyOn(SerialPort.binding, 'open').mockResolvedValue(
      port as unknown as Awaited<ReturnType<typeof SerialPort.binding.open>>,
    );
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['dtr', 'rts'] as const)('keeps the unused line low throughout %s PTT and releases both on close', async (method) => {
    const hardware = new PttHardware('/mock/ptt', method);
    await hardware.open();
    await hardware.set(true);
    await hardware.set(false);
    await hardware.set(true);
    await hardware.close();

    const idle = expect.objectContaining({ dtr: false, rts: false });
    const keyed = expect.objectContaining({ dtr: method === 'dtr', rts: method === 'rts' });
    expect(port.set.mock.calls.map(([signals]) => signals)).toEqual([idle, keyed, idle, keyed, idle]);
    expect(port.close).toHaveBeenCalledOnce();
    expect(port.set.mock.invocationCallOrder[4]).toBeLessThan(port.close.mock.invocationCallOrder[0]);
  });

  it.each(['dtr', 'rts'] as const)('rejects opening %s PTT when the idle-line reset fails', async (method) => {
    port.set.mockRejectedValueOnce(new Error('control line reset failed'));
    const hardware = new PttHardware('/mock/ptt', method);

    await expect(hardware.open()).rejects.toThrow('control line reset failed');
    expect(port.set).toHaveBeenCalledWith(expect.objectContaining({ dtr: false, rts: false }));
    expect(port.close).toHaveBeenCalledOnce();
  });
});
