import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serialPortListMock } = vi.hoisted(() => ({
  serialPortListMock: vi.fn(),
}));

vi.mock('serialport', () => ({
  default: {
    SerialPort: {
      list: serialPortListMock,
    },
  },
}));

import { HamlibConnection } from '../connections/HamlibConnection.js';
import type { RadioConnectionConfig } from '../connections/IRadioConnection.js';

type ResolveAccessor = {
  resolveSerialDevicePath(config: RadioConnectionConfig): Promise<RadioConnectionConfig>;
};

function resolveSerialDevicePath(connection: HamlibConnection, config: RadioConnectionConfig) {
  return (connection as unknown as ResolveAccessor).resolveSerialDevicePath(config);
}

function serialConfig(path: string, serialNumber: string | undefined): RadioConnectionConfig {
  return {
    type: 'serial',
    serial: {
      path,
      serialNumber,
      rigModel: 1234,
      backendConfig: { rig_pathname: path },
    },
  };
}

describe('HamlibConnection.resolveSerialDevicePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the config untouched when no serial number is configured', async () => {
    const connection = new HamlibConnection();
    const config = serialConfig('/dev/ttyUSB0', undefined);

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
    expect(serialPortListMock).not.toHaveBeenCalled();
  });

  it('keeps a configured macOS callout path when enumeration only reports the dialin node', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockResolvedValue([
      { path: '/dev/tty.usbserial-ABC123', serialNumber: 'SN-1' },
    ]);
    const config = serialConfig('/dev/cu.usbserial-ABC123', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
    expect(result.serial?.path).toBe('/dev/cu.usbserial-ABC123');
    expect(result.serial?.backendConfig?.rig_pathname).toBe('/dev/cu.usbserial-ABC123');
  });

  it('maps a re-enumerated dialin path back to the configured callout form', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockResolvedValue([
      { path: '/dev/tty.usbserial-XYZ999', serialNumber: 'SN-1' },
    ]);
    const config = serialConfig('/dev/cu.usbserial-ABC123', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result.serial?.path).toBe('/dev/cu.usbserial-XYZ999');
    expect(result.serial?.backendConfig?.rig_pathname).toBe('/dev/cu.usbserial-XYZ999');
  });

  it('rewrites the path when the device re-enumerates under a different name', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockResolvedValue([
      { path: '/dev/ttyUSB1', serialNumber: 'SN-1' },
    ]);
    const config = serialConfig('/dev/ttyUSB0', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result.serial?.path).toBe('/dev/ttyUSB1');
    expect(result.serial?.backendConfig?.rig_pathname).toBe('/dev/ttyUSB1');
  });

  it('skips resolution for host:port endpoints with a stale serial number', async () => {
    const connection = new HamlibConnection();
    const config = serialConfig('127.0.0.1:4532', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
    expect(serialPortListMock).not.toHaveBeenCalled();
  });

  it('skips resolution for custom non-device paths with a stale serial number', async () => {
    const connection = new HamlibConnection();
    const config = serialConfig('rigctl-proxy', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
    expect(serialPortListMock).not.toHaveBeenCalled();
  });

  it('falls back to the configured path when the serial number is not enumerated', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockResolvedValue([
      { path: '/dev/ttyUSB9', serialNumber: 'OTHER' },
    ]);
    const config = serialConfig('/dev/ttyUSB0', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
  });

  it('falls back to the configured path when enumeration fails', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockRejectedValue(new Error('permission denied'));
    const config = serialConfig('/dev/ttyUSB0', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
  });

  it('keeps the configured path when duplicate serial numbers still include it', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockResolvedValue([
      { path: '/dev/ttyUSB0', serialNumber: 'FTDI' },
      { path: '/dev/ttyUSB1', serialNumber: 'FTDI' },
    ]);
    const config = serialConfig('/dev/ttyUSB0', 'FTDI');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
  });

  it('keeps the configured path when duplicate serial numbers make the target ambiguous', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockResolvedValue([
      { path: '/dev/ttyUSB1', serialNumber: 'FTDI' },
      { path: '/dev/ttyUSB2', serialNumber: 'FTDI' },
    ]);
    const config = serialConfig('/dev/ttyUSB0', 'FTDI');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result).toBe(config);
    expect(result.serial?.path).toBe('/dev/ttyUSB0');
  });

  it('matches the serial number case-insensitively', async () => {
    const connection = new HamlibConnection();
    serialPortListMock.mockResolvedValue([
      { path: 'COM4', serialNumber: 'sn-1' },
    ]);
    const config = serialConfig('COM3', 'SN-1');

    const result = await resolveSerialDevicePath(connection, config);

    expect(result.serial?.path).toBe('COM4');
    expect(result.serial?.backendConfig?.rig_pathname).toBe('COM4');
  });
});
