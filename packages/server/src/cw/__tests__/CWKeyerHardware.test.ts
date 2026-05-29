import { afterEach, describe, expect, it, vi } from 'vitest';
import { CWKeyerHardware } from '../CWKeyerHardware.js';

type SetSignals = { dtr?: boolean; rts?: boolean };

interface MockSerialPortInstance {
  path: string;
  baudRate: number;
  autoOpen: boolean;
  closed: boolean;
  open: ReturnType<typeof vi.fn<any>>;
  close: ReturnType<typeof vi.fn<any>>;
  set: ReturnType<typeof vi.fn<any>>;
  setCalls: SetSignals[];
}

const serialPortMock = vi.hoisted(() => ({
  instances: [] as MockSerialPortInstance[],
  openError: null as Error | null,
  setErrors: [] as Error[],
  autoFlushSet: true,
  pendingSetCallbacks: [] as Array<(error?: Error | null) => void>,
}));

vi.mock('serialport', () => {
  class SerialPort {
    path: string;
    baudRate: number;
    autoOpen: boolean;
    closed = false;
    setCalls: SetSignals[] = [];

    constructor(options: { path: string; baudRate: number; autoOpen: boolean }) {
      this.path = options.path;
      this.baudRate = options.baudRate;
      this.autoOpen = options.autoOpen;
      serialPortMock.instances.push(this as unknown as MockSerialPortInstance);
    }

    open = vi.fn((callback: (error?: Error | null) => void) => {
      callback(serialPortMock.openError);
    });

    close = vi.fn((callback?: (error?: Error | null) => void) => {
      this.closed = true;
      callback?.(null);
    });

    set = vi.fn((signals: SetSignals, callback: (error?: Error | null) => void) => {
      this.setCalls.push(signals);
      const complete = (error?: Error | null) => {
        callback(error ?? serialPortMock.setErrors.shift() ?? null);
      };
      if (serialPortMock.autoFlushSet) {
        complete();
      } else {
        serialPortMock.pendingSetCallbacks.push(complete);
      }
    });
  }

  return { SerialPort };
});

function resetSerialPortMock(): void {
  serialPortMock.instances.length = 0;
  serialPortMock.openError = null;
  serialPortMock.setErrors.length = 0;
  serialPortMock.autoFlushSet = true;
  serialPortMock.pendingSetCallbacks.length = 0;
}

async function flushNextSet(error?: Error | null): Promise<void> {
  const callback = serialPortMock.pendingSetCallbacks.shift();
  if (!callback) {
    throw new Error('No pending serial port set callback');
  }
  callback(error ?? null);
  await Promise.resolve();
}

afterEach(() => {
  resetSerialPortMock();
  vi.restoreAllMocks();
});

describe('CWKeyerHardware', () => {
  it('resets both DTR and RTS before marking an opened port ready', async () => {
    serialPortMock.autoFlushSet = false;
    const hardware = new CWKeyerHardware('/dev/ttyUSB-cw', 'dtr');

    const openPromise = hardware.open();

    expect(serialPortMock.instances).toHaveLength(1);
    expect(serialPortMock.instances[0]?.setCalls).toEqual([{ rts: false, dtr: false }]);
    expect(hardware.isOpen).toBe(false);

    await flushNextSet();
    await openPromise;

    expect(hardware.isOpen).toBe(true);
  });

  it('keys only the configured control line after the open reset', async () => {
    const hardware = new CWKeyerHardware('/dev/ttyUSB-cw', 'dtr');
    await hardware.open();

    const port = serialPortMock.instances[0]!;
    port.setCalls.length = 0;

    await hardware.keyDown();
    await hardware.keyUp();

    expect(port.setCalls).toEqual([
      { dtr: true },
      { dtr: false },
    ]);
  });

  it('uses low-level key-down and high-level idle for inverted keying interfaces', async () => {
    const hardware = new CWKeyerHardware('/dev/ttyUSB-cw', 'rts', 'low');
    await hardware.open();

    const port = serialPortMock.instances[0]!;
    expect(port.setCalls).toEqual([{ rts: true, dtr: true }]);
    port.setCalls.length = 0;

    await hardware.keyDown();
    await hardware.keyUp();
    await hardware.close();

    expect(port.setCalls).toEqual([
      { rts: false },
      { rts: true },
      { rts: true, dtr: true },
    ]);
  });

  it('resets both DTR and RTS before close even when no key is down', async () => {
    const hardware = new CWKeyerHardware('/dev/ttyUSB-cw', 'rts');
    await hardware.open();

    const port = serialPortMock.instances[0]!;
    port.setCalls.length = 0;

    await hardware.close();

    expect(port.setCalls).toEqual([{ rts: false, dtr: false }]);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(hardware.isOpen).toBe(false);
    expect(hardware.isKeyDown).toBe(false);
  });

  it('closes best-effort and rejects when the open-time reset fails', async () => {
    serialPortMock.setErrors.push(new Error('reset failed'));
    const hardware = new CWKeyerHardware('/dev/ttyUSB-cw', 'dtr');

    await expect(hardware.open()).rejects.toThrow('Failed to reset CW key port /dev/ttyUSB-cw: reset failed');

    const port = serialPortMock.instances[0]!;
    expect(port.setCalls).toEqual([{ rts: false, dtr: false }]);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(hardware.isOpen).toBe(false);
    expect(hardware.isKeyDown).toBe(false);
  });
});
