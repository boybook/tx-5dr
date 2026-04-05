import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HamlibConnection } from '../connections/HamlibConnection.js';
import { RadioConnectionState } from '../connections/IRadioConnection.js';

type MockRig = {
  setFrequency: ReturnType<typeof vi.fn>;
  getSplit: ReturnType<typeof vi.fn>;
  setSplitFreq: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setPtt: ReturnType<typeof vi.fn>;
  getFrequency: ReturnType<typeof vi.fn>;
  getMode: ReturnType<typeof vi.fn>;
  getLevel: ReturnType<typeof vi.fn>;
};

type MockSpectrumController = {
  configureSpectrum: ReturnType<typeof vi.fn>;
  getSpectrumSupportSummary: ReturnType<typeof vi.fn>;
};

type TestFrequencyRange = {
  startFreq: number;
  endFreq: number;
  modes: string[];
  lowPower: number;
  highPower: number;
  vfo: number;
  antenna: number;
};

type HamlibConnectionTestAccessor = {
  rig: MockRig;
  state: RadioConnectionState;
  supportedModes?: Set<string>;
  supportedLevels?: Set<string>;
  meterDecodeStrategy?: {
    name: 'icom' | 'yaesu' | 'generic';
    sourceLevel: 'STRENGTH' | 'RAWSTR' | null;
    displayStyle: 's-meter-dbm' | 's-meter' | 'db-over-s9';
    label: string;
  };
  txFrequencyRanges?: TestFrequencyRange[];
  currentFrequencyHz?: number;
  currentRadioMode?: string;
  spectrumController?: MockSpectrumController;
  convertPower: (rawValue: number | null, wattsValue: number | null) => {
    raw: number;
    percent: number;
    watts: number | null;
    maxWatts: number | null;
  };
  resolveCurrentTxPowerMaxWatts: () => number | null;
};

function asTestConnection(connection: HamlibConnection): HamlibConnectionTestAccessor {
  return connection as unknown as HamlibConnectionTestAccessor;
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

function createConnectedConnection(rigOverrides: Partial<MockRig> = {}): {
  connection: HamlibConnection;
  rig: MockRig;
} {
  const connection = new HamlibConnection();
  const rig: MockRig = {
    setFrequency: vi.fn().mockResolvedValue(0),
    getSplit: vi.fn().mockResolvedValue({ enabled: false }),
    setSplitFreq: vi.fn().mockResolvedValue(0),
    setMode: vi.fn().mockResolvedValue(0),
    setPtt: vi.fn().mockResolvedValue(0),
    getFrequency: vi.fn().mockResolvedValue(7100000),
    getMode: vi.fn().mockResolvedValue({ mode: 'USB', bandwidth: 'wide' }),
    getLevel: vi.fn().mockResolvedValue(0),
    ...rigOverrides,
  };
  const testConnection = asTestConnection(connection);

  testConnection.rig = rig;
  testConnection.state = RadioConnectionState.CONNECTED;
  testConnection.meterDecodeStrategy = {
    name: 'generic',
    sourceLevel: 'STRENGTH',
    displayStyle: 'db-over-s9',
    label: 'generic-strength',
  };

  return { connection, rig };
}

describe('HamlibConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not write split TX frequency when split is disabled', async () => {
    const { connection, rig } = createConnectedConnection({
      getSplit: vi.fn().mockResolvedValue({ enabled: false }),
    });

    await connection.setFrequency(7100000);
    await connection.setFrequency(7200000);

    expect(rig.setFrequency).toHaveBeenCalledTimes(2);
    expect(rig.getSplit).toHaveBeenCalledTimes(1);
    expect(rig.setSplitFreq).not.toHaveBeenCalled();
  });

  it('writes split TX frequency when split is enabled', async () => {
    const { connection, rig } = createConnectedConnection({
      getSplit: vi.fn().mockResolvedValue({ enabled: true }),
    });

    await connection.setFrequency(7100000);
    await connection.setFrequency(7200000);

    expect(rig.getSplit).toHaveBeenCalledTimes(1);
    expect(rig.setSplitFreq).toHaveBeenCalledTimes(2);
    expect(rig.setSplitFreq).toHaveBeenNthCalledWith(1, 7100000);
    expect(rig.setSplitFreq).toHaveBeenNthCalledWith(2, 7200000);
  });

  it('falls back to plain RX writes when split probing is recoverably unsupported', async () => {
    const { connection, rig } = createConnectedConnection({
      getSplit: vi.fn().mockRejectedValue(new Error('Feature not available')),
    });

    await connection.setFrequency(7100000);
    await connection.setFrequency(7200000);

    expect(rig.setFrequency).toHaveBeenCalledTimes(2);
    expect(rig.getSplit).toHaveBeenCalledTimes(1);
    expect(rig.setSplitFreq).not.toHaveBeenCalled();
  });

  it('keeps setFrequency successful when split TX sync fails', async () => {
    const { connection, rig } = createConnectedConnection({
      getSplit: vi.fn().mockResolvedValue({ enabled: true }),
      setSplitFreq: vi.fn().mockRejectedValue(new Error('Protocol error')),
    });

    await expect(connection.setFrequency(7100000)).resolves.toBeUndefined();
    await expect(connection.setFrequency(7200000)).resolves.toBeUndefined();

    expect(rig.getSplit).toHaveBeenCalledTimes(1);
    expect(rig.setSplitFreq).toHaveBeenCalledTimes(2);
  });

  it('does not attempt split TX sync when the primary frequency write fails', async () => {
    const { connection, rig } = createConnectedConnection({
      setFrequency: vi.fn().mockRejectedValue(new Error('device disconnected')),
      getSplit: vi.fn().mockResolvedValue({ enabled: true }),
    });

    await expect(connection.setFrequency(7100000)).rejects.toThrow('device disconnected');

    expect(rig.getSplit).not.toHaveBeenCalled();
    expect(rig.setSplitFreq).not.toHaveBeenCalled();
  });

  it('serializes queued CAT operations so later writes wait for earlier writes to finish', async () => {
    const firstWrite = createDeferred<number>();
    const { connection, rig } = createConnectedConnection({
      setFrequency: vi.fn()
        .mockReturnValueOnce(firstWrite.promise)
        .mockResolvedValueOnce(0),
      getSplit: vi.fn().mockResolvedValue({ enabled: false }),
    });

    const first = connection.setFrequency(7100000);
    await Promise.resolve();

    const second = connection.setFrequency(7200000);
    await Promise.resolve();

    expect(rig.setFrequency).toHaveBeenCalledTimes(1);
    expect(rig.setFrequency).toHaveBeenNthCalledWith(1, 7100000);

    firstWrite.resolve(0);
    await first;
    await second;

    expect(rig.setFrequency).toHaveBeenCalledTimes(2);
    expect(rig.setFrequency).toHaveBeenNthCalledWith(2, 7200000);
    expect(rig.getSplit).toHaveBeenCalledTimes(1);
  });

  it('prefers DATA mode for digital intent when supported', async () => {
    const { connection, rig } = createConnectedConnection();
    asTestConnection(connection).supportedModes = new Set(['USB', 'PKTUSB']);

    await expect(connection.setMode('USB', undefined, { intent: 'digital' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith('PKTUSB', undefined);
  });

  it('falls back to standard mode for digital intent when DATA mode is unsupported', async () => {
    const { connection, rig } = createConnectedConnection();
    asTestConnection(connection).supportedModes = new Set(['USB']);

    await expect(connection.setMode('USB', undefined, { intent: 'digital' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith('USB', undefined);
  });

  it('keeps standard mode for voice intent even when DATA mode is supported', async () => {
    const { connection, rig } = createConnectedConnection();
    asTestConnection(connection).supportedModes = new Set(['USB', 'PKTUSB']);

    await expect(connection.setMode('USB', undefined, { intent: 'voice' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith('USB', undefined);
  });

  it('normalizes explicit DATA mode back to standard mode for voice intent', async () => {
    const { connection, rig } = createConnectedConnection();
    asTestConnection(connection).supportedModes = new Set(['USB', 'PKTUSB']);

    await expect(connection.setMode('PKTUSB', undefined, { intent: 'voice' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith('USB', undefined);
  });

  it('passes through nochange bandwidth selectors to hamlib', async () => {
    const { connection, rig } = createConnectedConnection();

    await expect(connection.setMode('USB', 'nochange', { intent: 'voice' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith('USB', 'nochange');
  });

  it('passes through numeric passband widths to hamlib', async () => {
    const { connection, rig } = createConnectedConnection();

    await expect(connection.setMode('USB', 2400, { intent: 'voice' })).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith('USB', 2400);
  });

  it('applies frequency and mode as a single critical operating-state update', async () => {
    const { connection, rig } = createConnectedConnection();
    const testConnection = asTestConnection(connection);
    testConnection.supportedModes = new Set(['USB']);
    testConnection.currentRadioMode = 'LSB';

    const result = await connection.applyOperatingState({
      frequency: 7100000,
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'voice' },
    });

    expect(result).toEqual({
      frequencyApplied: true,
      modeApplied: true,
      modeError: undefined,
    });
    expect(rig.setMode).toHaveBeenCalledTimes(1);
    expect(rig.setFrequency).toHaveBeenCalledTimes(2);
  });

  it('returns a non-fatal mode error when operating-state writes tolerate mode failures', async () => {
    const { connection, rig } = createConnectedConnection({
      setMode: vi.fn().mockRejectedValue(new Error('mode not supported')),
    });

    const result = await connection.applyOperatingState({
      frequency: 7100000,
      mode: 'USB',
      tolerateModeFailure: true,
    });

    expect(result.frequencyApplied).toBe(true);
    expect(result.modeApplied).toBe(false);
    expect(result.modeError?.message).toContain('mode not supported');
    expect(rig.setFrequency).toHaveBeenCalledTimes(1);
  });

  it('reads meter levels sequentially inside a single polling pass', async () => {
    const firstRead = createDeferred<number>();
    const { connection, rig } = createConnectedConnection({
      getLevel: vi.fn()
        .mockImplementationOnce(() => firstRead.promise)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(5),
    });
    asTestConnection(connection).supportedLevels = new Set([
      'STRENGTH',
      'SWR',
      'ALC',
      'RFPOWER_METER',
      'RFPOWER_METER_WATTS',
    ]);

    const pollPromise = (connection as any).pollMeters();
    await Promise.resolve();
    await Promise.resolve();

    expect(rig.getLevel).toHaveBeenCalledTimes(1);
    expect(rig.getLevel).toHaveBeenNthCalledWith(1, 'STRENGTH');

    firstRead.resolve(1);
    await pollPromise;

    expect(rig.getLevel).toHaveBeenCalledTimes(5);
    expect(rig.getLevel).toHaveBeenNthCalledWith(2, 'SWR');
    expect(rig.getLevel).toHaveBeenNthCalledWith(3, 'ALC');
    expect(rig.getLevel).toHaveBeenNthCalledWith(4, 'RFPOWER_METER');
    expect(rig.getLevel).toHaveBeenNthCalledWith(5, 'RFPOWER_METER_WATTS');
  });

  it('skips low-priority meter polling while a critical CAT write is active', async () => {
    const firstWrite = createDeferred<number>();
    const { connection, rig } = createConnectedConnection({
      setFrequency: vi.fn().mockReturnValue(firstWrite.promise),
    });
    asTestConnection(connection).supportedLevels = new Set(['STRENGTH']);

    const writePromise = connection.setFrequency(7100000);
    await Promise.resolve();

    await (connection as any).pollMeters();

    expect(rig.getLevel).not.toHaveBeenCalled();

    firstWrite.resolve(0);
    await writePromise;
  });

  it('reads RAWSTR instead of STRENGTH when the Yaesu meter strategy is active', async () => {
    const { connection, rig } = createConnectedConnection({
      getLevel: vi.fn()
        .mockImplementation(async (level: string) => {
          if (level === 'RAWSTR') return 150;
          throw new Error(`unexpected level ${level}`);
        }),
    });
    const testConnection = asTestConnection(connection);
    testConnection.supportedLevels = new Set(['RAWSTR']);
    testConnection.meterDecodeStrategy = {
      name: 'yaesu',
      sourceLevel: 'RAWSTR',
      displayStyle: 's-meter',
      label: 'yaesu-rawstr',
    };

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

    expect(rig.getLevel).toHaveBeenCalledTimes(1);
    expect(rig.getLevel).toHaveBeenCalledWith('RAWSTR');
    expect(emitted[0]?.level).toMatchObject({
      raw: 150,
      formatted: 'S9',
      displayStyle: 's-meter',
    });
  });

  it('keeps generic rigs on dB relative to S9 formatting', async () => {
    const { connection, rig } = createConnectedConnection({
      getLevel: vi.fn().mockResolvedValue(-24),
    });
    const testConnection = asTestConnection(connection);
    testConnection.supportedLevels = new Set(['STRENGTH']);
    testConnection.meterDecodeStrategy = {
      name: 'generic',
      sourceLevel: 'STRENGTH',
      displayStyle: 'db-over-s9',
      label: 'generic-strength',
    };

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

    expect(rig.getLevel).toHaveBeenCalledWith('STRENGTH');
    expect(emitted[0]?.level).toMatchObject({
      formatted: '-24 dB@S9',
      displayStyle: 'db-over-s9',
    });
  });

  it('uses the matched TX range max watts when converting absolute power readings', () => {
    const { connection } = createConnectedConnection();
    const testConnection = asTestConnection(connection);
    testConnection.txFrequencyRanges = [
      {
        startFreq: 1000000,
        endFreq: 30000000,
        modes: ['USB', 'AM'],
        lowPower: 100,
        highPower: 100000,
        vfo: 0,
        antenna: 0,
      },
      {
        startFreq: 1000000,
        endFreq: 30000000,
        modes: ['AM'],
        lowPower: 100,
        highPower: 25000,
        vfo: 0,
        antenna: 0,
      },
    ];
    testConnection.currentFrequencyHz = 14074000;
    testConnection.currentRadioMode = 'AM';

    const result = testConnection.convertPower(null, 12.5);

    expect(result).toEqual({
      raw: 127,
      percent: 50,
      watts: 12.5,
      maxWatts: 25,
    });
  });

  it('falls back to the rig-wide TX max watts when no exact range matches', () => {
    const { connection } = createConnectedConnection();
    const testConnection = asTestConnection(connection);
    testConnection.txFrequencyRanges = [
      {
        startFreq: 1000000,
        endFreq: 30000000,
        modes: ['USB'],
        lowPower: 100,
        highPower: 10000,
        vfo: 0,
        antenna: 0,
      },
    ];
    testConnection.currentFrequencyHz = 50000000;
    testConnection.currentRadioMode = 'FM';

    expect(testConnection.resolveCurrentTxPowerMaxWatts()).toBe(10);
  });

  it('applies spectrum runtime speed updates when the backend supports SPECTRUM_SPEED', async () => {
    const { connection } = createConnectedConnection();
    const configureSpectrum = vi.fn().mockResolvedValue(undefined);

    asTestConnection(connection).spectrumController = {
      configureSpectrum,
      getSpectrumSupportSummary: vi.fn().mockResolvedValue({
        configurableLevels: ['SPECTRUM_SPEED'],
      }),
    };

    await expect(connection.applySpectrumRuntimeConfig?.({ speed: 10 })).resolves.toBeUndefined();

    expect(configureSpectrum).toHaveBeenCalledWith({ speed: 10 });
  });

  it('ignores spectrum runtime speed updates when the backend does not support SPECTRUM_SPEED', async () => {
    const { connection } = createConnectedConnection();
    const configureSpectrum = vi.fn().mockResolvedValue(undefined);

    asTestConnection(connection).spectrumController = {
      configureSpectrum,
      getSpectrumSupportSummary: vi.fn().mockResolvedValue({
        configurableLevels: [],
      }),
    };

    await expect(connection.applySpectrumRuntimeConfig?.({ speed: 10 })).resolves.toBeUndefined();

    expect(configureSpectrum).not.toHaveBeenCalled();
  });

  it('clamps percent to 100 when the absolute power reading exceeds the matched max watts', () => {
    const { connection } = createConnectedConnection();
    const testConnection = asTestConnection(connection);
    testConnection.txFrequencyRanges = [
      {
        startFreq: 1000000,
        endFreq: 30000000,
        modes: ['USB'],
        lowPower: 100,
        highPower: 10000,
        vfo: 0,
        antenna: 0,
      },
    ];
    testConnection.currentFrequencyHz = 14074000;
    testConnection.currentRadioMode = 'USB';

    const result = testConnection.convertPower(15, null);

    expect(result).toEqual({
      raw: 255,
      percent: 100,
      watts: 15,
      maxWatts: 10,
    });
  });
});
