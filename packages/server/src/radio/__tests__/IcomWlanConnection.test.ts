import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('icom-wlan-node', () => ({
  IcomControl: class MockIcomControl {},
  AUDIO_RATE: 48000,
}));

import { IcomWlanConnection } from '../connections/IcomWlanConnection.js';
import { RadioConnectionState } from '../connections/IRadioConnection.js';

type MockRig = {
  setFrequency: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setPtt: ReturnType<typeof vi.fn>;
  readSWR: ReturnType<typeof vi.fn>;
  readALC: ReturnType<typeof vi.fn>;
  getLevelMeter: ReturnType<typeof vi.fn>;
  readPowerLevel: ReturnType<typeof vi.fn>;
};

type IcomWlanConnectionTestAccessor = {
  rig: MockRig;
  state: RadioConnectionState;
  defaultDataMode: boolean;
};

function asTestConnection(connection: IcomWlanConnection): IcomWlanConnectionTestAccessor {
  return connection as unknown as IcomWlanConnectionTestAccessor;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createConnectedConnection(): { connection: IcomWlanConnection; rig: MockRig } {
  const connection = new IcomWlanConnection();
  const rig: MockRig = {
    setFrequency: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setPtt: vi.fn().mockResolvedValue(undefined),
    readSWR: vi.fn().mockResolvedValue(null),
    readALC: vi.fn().mockResolvedValue(null),
    getLevelMeter: vi.fn().mockResolvedValue(null),
    readPowerLevel: vi.fn().mockResolvedValue(null),
  };

  const testConnection = asTestConnection(connection);
  testConnection.rig = rig;
  testConnection.state = RadioConnectionState.CONNECTED;
  testConnection.defaultDataMode = true;

  return { connection, rig };
}

describe('IcomWlanConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats nochange as keep-current-bandwidth semantics', async () => {
    const { connection, rig } = createConnectedConnection();

    await expect(connection.setMode('USB', 'nochange')).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith(expect.any(Number), { dataMode: true });
  });

  it('rejects numeric passband widths', async () => {
    const { connection, rig } = createConnectedConnection();

    await expect(connection.setMode('USB', 2400)).rejects.toThrow(
      'ICOM WLAN setMode does not support numeric passband widths'
    );

    expect(rig.setMode).not.toHaveBeenCalled();
  });

  it('applies frequency and mode as one critical operating-state update', async () => {
    const { connection, rig } = createConnectedConnection();

    const result = await connection.applyOperatingState({
      frequency: 7100000,
      mode: 'USB',
      bandwidth: 'nochange',
    });

    expect(result).toEqual({
      frequencyApplied: true,
      modeApplied: true,
      modeError: undefined,
    });
    expect(rig.setFrequency).toHaveBeenCalledWith(7100000);
    expect(rig.setMode).toHaveBeenCalledTimes(1);
  });

  it('reads ICOM meter values sequentially within one polling pass', async () => {
    const firstRead = createDeferred<any>();
    const { connection, rig } = createConnectedConnection();
    rig.readSWR
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValueOnce(null);
    rig.readALC.mockResolvedValueOnce(null);
    rig.getLevelMeter.mockResolvedValueOnce(null);
    rig.readPowerLevel.mockResolvedValueOnce(null);

    const pollPromise = (connection as any).pollMeters();
    await Promise.resolve();
    await Promise.resolve();

    expect(rig.readSWR).toHaveBeenCalledTimes(1);
    expect(rig.readALC).not.toHaveBeenCalled();

    firstRead.resolve(null);
    await pollPromise;

    expect(rig.readALC).toHaveBeenCalledTimes(1);
    expect(rig.getLevelMeter).toHaveBeenCalledTimes(1);
    expect(rig.readPowerLevel).toHaveBeenCalledTimes(1);
  });

  it('skips low-priority meter polling while a critical ICOM CAT write is active', async () => {
    const firstWrite = createDeferred<void>();
    const { connection, rig } = createConnectedConnection();
    rig.setFrequency.mockReturnValueOnce(firstWrite.promise);

    const writePromise = connection.setFrequency(7100000);
    await Promise.resolve();

    await (connection as any).pollMeters();

    expect(rig.readSWR).not.toHaveBeenCalled();

    firstWrite.resolve(undefined);
    await writePromise;
  });

  it('tags ICOM level readings with the branded display style', async () => {
    const { connection, rig } = createConnectedConnection();
    rig.getLevelMeter.mockResolvedValueOnce({
      raw: 120,
      percent: 50,
      sUnits: 9,
      dBm: -73,
      formatted: 'S9',
    });

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

    expect(emitted[0]?.level).toMatchObject({
      raw: 120,
      formatted: 'S9',
      displayStyle: 's-meter-dbm',
    });
  });
});
