import { beforeEach, describe, expect, it, vi } from 'vitest';

const icomWlanMock = vi.hoisted(() => {
  const constructorCalls: unknown[] = [];

  class MockIcomControl {
    events: any;

    constructor(options: unknown) {
      const events: any = {};
      events.on = vi.fn(() => events);
      events.once = vi.fn(() => events);
      events.off = vi.fn(() => events);
      events.removeAllListeners = vi.fn(() => events);
      this.events = events;
      constructorCalls.push(options);
    }

    configureMonitoring = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    getConnectionPhase = vi.fn(() => 'CONNECTED');
  }

  return { MockIcomControl, constructorCalls };
});

vi.mock('icom-wlan-node', () => ({
  IcomControl: icomWlanMock.MockIcomControl,
  AUDIO_RATE: 48000,
}));

import { IcomWlanConnection } from '../connections/IcomWlanConnection.js';
import { RadioConnectionState } from '../connections/IRadioConnection.js';
import { RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';

type MockRig = {
  setFrequency: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setPtt: ReturnType<typeof vi.fn>;
  readOperatingFrequency: ReturnType<typeof vi.fn>;
  readOperatingMode: ReturnType<typeof vi.fn>;
  readTransceiverState: ReturnType<typeof vi.fn>;
  readSWR: ReturnType<typeof vi.fn>;
  readALC: ReturnType<typeof vi.fn>;
  getLevelMeter: ReturnType<typeof vi.fn>;
  readPowerLevel: ReturnType<typeof vi.fn>;
  getAFGain: ReturnType<typeof vi.fn>;
  enableScope: ReturnType<typeof vi.fn>;
  disableScope: ReturnType<typeof vi.fn>;
  readScopeSpan: ReturnType<typeof vi.fn>;
  setScopeSpan: ReturnType<typeof vi.fn>;
  getSpectrumDisplayState: ReturnType<typeof vi.fn>;
  configureSpectrumDisplay: ReturnType<typeof vi.fn>;
};

type IcomWlanConnectionTestAccessor = {
  rig: MockRig;
  state: RadioConnectionState;
  defaultDataMode: boolean;
  softwarePttActive: boolean;
  pttActivatedAt: number | null;
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
    readOperatingFrequency: vi.fn().mockResolvedValue(7100000),
    readOperatingMode: vi.fn().mockResolvedValue({ mode: 1, modeName: 'USB', filterName: 'Normal' }),
    readTransceiverState: vi.fn().mockResolvedValue('RX'),
    readSWR: vi.fn().mockResolvedValue(null),
    readALC: vi.fn().mockResolvedValue(null),
    getLevelMeter: vi.fn().mockResolvedValue(null),
    readPowerLevel: vi.fn().mockResolvedValue(null),
    getAFGain: vi.fn().mockResolvedValue({ normalized: 0.5 }),
    enableScope: vi.fn().mockResolvedValue(undefined),
    disableScope: vi.fn().mockResolvedValue(undefined),
    readScopeSpan: vi.fn().mockResolvedValue({ spanHz: 50000 }),
    setScopeSpan: vi.fn().mockResolvedValue(undefined),
    getSpectrumDisplayState: vi.fn().mockResolvedValue({
      mode: 'center',
      spanHz: 50000,
      supportedSpans: [50000],
    }),
    configureSpectrumDisplay: vi.fn().mockResolvedValue(undefined),
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
    icomWlanMock.constructorCalls.length = 0;
  });

  it('passes auto model detection to icom-wlan-node', async () => {
    vi.useFakeTimers();
    try {
      const connection = new IcomWlanConnection();

      await connection.connect({
        type: 'icom-wlan',
        icomWlan: {
          ip: '192.168.1.100',
          port: 50001,
          userName: 'ICOM',
          password: 'secret',
          dataMode: true,
        },
      });

      expect(icomWlanMock.constructorCalls[0]).toMatchObject({
        control: {
          ip: '192.168.1.100',
          port: 50001,
        },
        userName: 'ICOM',
        password: 'secret',
        model: 'auto',
      });
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats nochange as keep-current-bandwidth semantics', async () => {
    const { connection, rig } = createConnectedConnection();

    await expect(connection.setMode('USB', 'nochange')).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith(expect.any(Number), { dataMode: true });
  });

  it('uses data mode for digital mode writes even when the ICOM WLAN default is voice mode', async () => {
    const { connection, rig } = createConnectedConnection();
    asTestConnection(connection).defaultDataMode = false;

    await expect(connection.setMode('USB', 'nochange', { intent: 'digital' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith(expect.any(Number), { dataMode: true });
  });

  it('uses voice mode for voice mode writes even when the ICOM WLAN default is data mode', async () => {
    const { connection, rig } = createConnectedConnection();
    asTestConnection(connection).defaultDataMode = true;

    await expect(connection.setMode('USB', 'nochange', { intent: 'voice' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith(expect.any(Number), { dataMode: false });
  });

  it('passes digital intent through applyOperatingState', async () => {
    const { connection, rig } = createConnectedConnection();
    asTestConnection(connection).defaultDataMode = false;

    const result = await connection.applyOperatingState({
      frequency: 7100000,
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'digital' },
    });

    expect(result.modeApplied).toBe(true);
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

  it('dedupes concurrent getFrequency reads through the CAT queue', async () => {
    const read = createDeferred<number>();
    const { connection, rig } = createConnectedConnection();
    rig.readOperatingFrequency.mockReturnValueOnce(read.promise);

    const first = connection.getFrequency();
    await Promise.resolve();
    const second = connection.getFrequency();

    expect(rig.readOperatingFrequency).toHaveBeenCalledTimes(1);

    read.resolve(7100000);
    await expect(Promise.all([first, second])).resolves.toEqual([7100000, 7100000]);
    expect(rig.readOperatingFrequency).toHaveBeenCalledTimes(1);
  });

  it('limits ICOM WLAN CAT work to three concurrent queue tasks', async () => {
    const frequencyRead = createDeferred<number>();
    const modeRead = createDeferred<any>();
    const pttRead = createDeferred<string>();
    const gainRead = createDeferred<any>();
    const { connection, rig } = createConnectedConnection();
    rig.readOperatingFrequency.mockReturnValueOnce(frequencyRead.promise);
    rig.readOperatingMode.mockReturnValueOnce(modeRead.promise);
    rig.readTransceiverState.mockReturnValueOnce(pttRead.promise);
    rig.getAFGain.mockReturnValueOnce(gainRead.promise);

    const frequencyPromise = connection.getFrequency();
    const modePromise = connection.getMode();
    const pttPromise = connection.getPTT();
    const gainPromise = connection.getAFGain();

    await vi.waitFor(() => {
      expect(rig.readOperatingFrequency).toHaveBeenCalledTimes(1);
      expect(rig.readOperatingMode).toHaveBeenCalledTimes(1);
      expect(rig.readTransceiverState).toHaveBeenCalledTimes(1);
    });
    expect(rig.getAFGain).not.toHaveBeenCalled();
    expect(connection.getRadioIoQueueSnapshot()).toMatchObject({
      activeCount: 3,
      pendingCount: 1,
      backpressure: false,
    });

    frequencyRead.resolve(7100000);
    await vi.waitFor(() => {
      expect(rig.getAFGain).toHaveBeenCalledTimes(1);
    });

    modeRead.resolve({ mode: 1, modeName: 'USB', filterName: 'Normal' });
    pttRead.resolve('RX');
    gainRead.resolve({ normalized: 0.25 });

    await expect(Promise.all([frequencyPromise, modePromise, pttPromise, gainPromise])).resolves.toEqual([
      7100000,
      { mode: 'USB', bandwidth: 'Normal' },
      false,
      0.25,
    ]);
  });

  it('returns the last known frequency for transient null ICOM frequency readback', async () => {
    const { connection, rig } = createConnectedConnection();
    connection.setKnownFrequency(7100000);
    rig.readOperatingFrequency.mockResolvedValue(null);

    await expect(connection.getFrequency()).resolves.toBe(7100000);
    await expect(connection.getFrequency()).resolves.toBe(7100000);
    expect(rig.readOperatingFrequency).toHaveBeenCalledTimes(2);
  });

  it('returns zero for transient null ICOM frequency readback without a known frequency', async () => {
    const { connection, rig } = createConnectedConnection();
    rig.readOperatingFrequency.mockResolvedValueOnce(null);

    await expect(connection.getFrequency()).resolves.toBe(0);
  });

  it('escalates repeated null ICOM frequency readback after three attempts', async () => {
    const { connection, rig } = createConnectedConnection();
    connection.setKnownFrequency(7100000);
    rig.readOperatingFrequency.mockResolvedValue(null);

    await expect(connection.getFrequency()).resolves.toBe(7100000);
    await expect(connection.getFrequency()).resolves.toBe(7100000);
    await expect(connection.getFrequency()).rejects.toMatchObject({
      code: RadioErrorCode.UNKNOWN_ERROR,
      context: expect.objectContaining({ operation: 'getFrequency' }),
    });
  });

  it('escalates sustained null ICOM frequency readback after the failure window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const { connection, rig } = createConnectedConnection();
      connection.setKnownFrequency(7100000);
      rig.readOperatingFrequency.mockResolvedValue(null);

      await expect(connection.getFrequency()).resolves.toBe(7100000);
      vi.setSystemTime(new Date(8001));
      await expect(connection.getFrequency()).rejects.toThrow(/Get frequency returned null/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the null frequency failure window after a successful read', async () => {
    const { connection, rig } = createConnectedConnection();
    rig.readOperatingFrequency
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(7100000)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(connection.getFrequency()).resolves.toBe(0);
    await expect(connection.getFrequency()).resolves.toBe(7100000);
    await expect(connection.getFrequency()).resolves.toBe(7100000);
    await expect(connection.getFrequency()).resolves.toBe(7100000);
  });

  it('dedupes fan-out getMode null readback through one bottom request', async () => {
    const modeRead = createDeferred<null>();
    const { connection, rig } = createConnectedConnection();
    rig.readOperatingMode.mockReturnValueOnce(modeRead.promise);

    const first = connection.getMode();
    await Promise.resolve();
    const second = connection.getMode();

    expect(rig.readOperatingMode).toHaveBeenCalledTimes(1);
    modeRead.resolve(null);

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(rig.readOperatingMode).toHaveBeenCalledTimes(1);
  });

  it('treats null ICOM mode readback as a recoverable optional read failure', async () => {
    const { connection, rig } = createConnectedConnection();
    rig.readOperatingMode.mockResolvedValueOnce(null);

    await expect(connection.getMode()).rejects.toMatchObject({
      code: RadioErrorCode.INVALID_OPERATION,
      severity: RadioErrorSeverity.WARNING,
      context: expect.objectContaining({
        operation: 'getMode',
        optional: true,
        recoverable: true,
      }),
    });
  });

  it('maps ICOM transceiver TX/RX state to PTT state', async () => {
    const { connection, rig } = createConnectedConnection();
    rig.readTransceiverState
      .mockResolvedValueOnce('TX')
      .mockResolvedValueOnce('RX');

    await expect(connection.getPTT()).resolves.toBe(true);
    await expect(connection.getPTT()).resolves.toBe(false);

    expect(rig.readTransceiverState).toHaveBeenCalledWith({ timeout: 1000 });
  });

  it('treats unknown ICOM transceiver state as unavailable PTT state', async () => {
    const { connection, rig } = createConnectedConnection();
    rig.readTransceiverState.mockResolvedValueOnce('UNKNOWN');

    await expect(connection.getPTT()).rejects.toThrow(/getPTT/);
  });

  it('reads supported ICOM TX meter values sequentially within one polling pass', async () => {
    const firstRead = createDeferred<any>();
    const { connection, rig } = createConnectedConnection();
    const testConnection = asTestConnection(connection);
    testConnection.softwarePttActive = true;
    testConnection.pttActivatedAt = Date.now() - 1000;
    rig.readSWR
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValueOnce(null);
    rig.readALC.mockResolvedValueOnce(null);
    rig.getLevelMeter.mockResolvedValueOnce(null);

    const pollPromise = (connection as any).pollMeters();
    await Promise.resolve();
    await Promise.resolve();

    expect(rig.readSWR).toHaveBeenCalledTimes(1);
    expect(rig.readALC).not.toHaveBeenCalled();
    expect(rig.getLevelMeter).not.toHaveBeenCalled();

    firstRead.resolve(null);
    await pollPromise;

    expect(rig.readALC).toHaveBeenCalledTimes(1);
    expect(rig.getLevelMeter).not.toHaveBeenCalled();
    expect(rig.readPowerLevel).toHaveBeenCalledTimes(1);
  });

  it('marks ICOM WLAN power meter supported by calibrated icom-wlan-node profiles', () => {
    const { connection } = createConnectedConnection();

    expect(connection.getMeterCapabilities()).toMatchObject({
      strength: true,
      swr: true,
      alc: true,
      power: true,
      powerWatts: true,
    });
  });

  it('does not read TX-only meters while ICOM WLAN PTT is inactive', async () => {
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

    expect(rig.getLevelMeter).toHaveBeenCalledTimes(1);
    expect(rig.readSWR).not.toHaveBeenCalled();
    expect(rig.readALC).not.toHaveBeenCalled();
    expect(rig.readPowerLevel).not.toHaveBeenCalled();
    expect(emitted[0]).toMatchObject({
      swr: null,
      alc: null,
      power: null,
    });
  });

  it('clamps ICOM WLAN SWR meter readings to the physical minimum of 1.0', async () => {
    const { connection, rig } = createConnectedConnection();
    const testConnection = asTestConnection(connection);
    testConnection.softwarePttActive = true;
    testConnection.pttActivatedAt = Date.now() - 1000;
    rig.readSWR.mockResolvedValueOnce({ raw: 0, swr: 0, alert: false });
    rig.readALC.mockResolvedValueOnce(null);
    rig.readPowerLevel.mockResolvedValueOnce(null);

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

    expect(emitted[0]?.swr).toMatchObject({ raw: 0, swr: 1 });
  });

  it('allows low-priority meter polling while a critical ICOM UDP write is active', async () => {
    const firstWrite = createDeferred<void>();
    const { connection, rig } = createConnectedConnection();
    rig.setFrequency.mockReturnValueOnce(firstWrite.promise);
    rig.getLevelMeter.mockResolvedValueOnce({
      raw: 120,
      percent: 50,
      sUnits: 9,
      dBm: -73,
      formatted: 'S9',
    });

    const writePromise = connection.setFrequency(7100000);
    await Promise.resolve();

    expect(connection.isCriticalOperationActive()).toBe(false);
    expect(connection.getRadioIoQueueSnapshot()).toMatchObject({
      busy: true,
      backpressure: false,
    });

    await (connection as any).pollMeters();

    expect(rig.getLevelMeter).toHaveBeenCalledTimes(1);

    firstWrite.resolve(undefined);
    await writePromise;
  });

  it('passes calibrated ICOM WLAN power watts through meter polling', async () => {
    const { connection, rig } = createConnectedConnection();
    const testConnection = asTestConnection(connection);
    testConnection.softwarePttActive = true;
    testConnection.pttActivatedAt = Date.now() - 1000;
    rig.readSWR.mockResolvedValueOnce(null);
    rig.readALC.mockResolvedValueOnce(null);
    rig.readPowerLevel.mockResolvedValueOnce({ raw: 143, percent: 50, watts: 50 });

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

    expect(emitted[0]?.power).toMatchObject({
      raw: 143,
      percent: 50,
      watts: 50,
      maxWatts: null,
    });
  });

  it('keeps ICOM spectrum display polling out of the main CAT queue', async () => {
    const displayRead = createDeferred<any>();
    const { connection, rig } = createConnectedConnection();
    rig.getSpectrumDisplayState.mockReturnValueOnce(displayRead.promise);

    const displayPromise = connection.getSpectrumDisplayState();
    await Promise.resolve();

    const frequencyPromise = connection.setFrequency(7100000);
    await frequencyPromise;

    expect(rig.setFrequency).toHaveBeenCalledWith(7100000);
    expect(rig.getSpectrumDisplayState).toHaveBeenCalledTimes(1);

    displayRead.resolve({ mode: 'center', spanHz: 50000, supportedSpans: [50000] });
    await expect(displayPromise).resolves.toMatchObject({ mode: 'center', spanHz: 50000 });
  });

  it('does not stack repeated ICOM spectrum display polls while a previous poll is active', async () => {
    const displayRead = createDeferred<any>();
    const { connection, rig } = createConnectedConnection();
    rig.getSpectrumDisplayState.mockReturnValueOnce(displayRead.promise);

    const firstPoll = connection.getSpectrumDisplayState();
    await Promise.resolve();

    await expect(connection.getSpectrumDisplayState()).resolves.toBeNull();
    expect(rig.getSpectrumDisplayState).toHaveBeenCalledTimes(1);

    displayRead.resolve({ mode: 'center', spanHz: 50000, supportedSpans: [50000] });
    await firstPoll;
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
