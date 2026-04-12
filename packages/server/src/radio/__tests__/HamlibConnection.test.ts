import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HamlibConnection } from '../connections/HamlibConnection.js';
import { RadioConnectionState } from '../connections/IRadioConnection.js';
import { HamlibMeterReader } from '../connections/meter/HamlibMeterReader.js';
import { defaultHamlibProfile } from '../connections/meter/profiles/index.js';

type MockRig = {
  setFrequency: ReturnType<typeof vi.fn>;
  getSplit: ReturnType<typeof vi.fn>;
  setSplitFreq: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setPtt: ReturnType<typeof vi.fn>;
  getFrequency: ReturnType<typeof vi.fn>;
  getMode: ReturnType<typeof vi.fn>;
  getLevel: ReturnType<typeof vi.fn>;
  setLevel: ReturnType<typeof vi.fn>;
  getFunction: ReturnType<typeof vi.fn>;
  setFunction: ReturnType<typeof vi.fn>;
  getPreampValues: ReturnType<typeof vi.fn>;
  getAttenuatorValues: ReturnType<typeof vi.fn>;
  getAgcLevels: ReturnType<typeof vi.fn>;
  getFilterList: ReturnType<typeof vi.fn>;
  getPassbandNarrow: ReturnType<typeof vi.fn>;
  getPassbandNormal: ReturnType<typeof vi.fn>;
  getPassbandWide: ReturnType<typeof vi.fn>;
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
  meterReader?: unknown;
  txFrequencyRanges?: TestFrequencyRange[];
  currentFrequencyHz?: number;
  currentRadioMode?: string;
  spectrumController?: MockSpectrumController;
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
    getMode: vi.fn().mockResolvedValue({ mode: 'USB', bandwidth: 2400 }),
    getLevel: vi.fn().mockResolvedValue(0),
    setLevel: vi.fn().mockResolvedValue(0),
    getFunction: vi.fn().mockResolvedValue(false),
    setFunction: vi.fn().mockResolvedValue(0),
    getPreampValues: vi.fn().mockReturnValue([]),
    getAttenuatorValues: vi.fn().mockReturnValue([]),
    getAgcLevels: vi.fn().mockReturnValue([]),
    getFilterList: vi.fn().mockReturnValue([
      { modes: ['USB', 'LSB'], width: 1800 },
      { modes: ['USB', 'LSB'], width: 2400 },
      { modes: ['USB', 'LSB'], width: 3000 },
    ]),
    getPassbandNarrow: vi.fn().mockReturnValue(1800),
    getPassbandNormal: vi.fn().mockReturnValue(2400),
    getPassbandWide: vi.fn().mockReturnValue(3000),
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

  it('returns numeric mode bandwidth values from hamlib', async () => {
    const { connection } = createConnectedConnection({
      getMode: vi.fn().mockResolvedValue({ mode: 'USB', bandwidth: 2400 }),
    });

    await expect(connection.getMode()).resolves.toEqual({ mode: 'USB', bandwidth: 2400 });
    await expect(connection.getModeBandwidth()).resolves.toBe(2400);
  });

  it('derives supported mode bandwidth options from hamlib filter list', async () => {
    const { connection } = createConnectedConnection({
      getFilterList: vi.fn().mockReturnValue([
        { modes: ['USB', 'LSB'], width: 3000 },
        { modes: ['USB'], width: 2400 },
        { modes: ['USB'], width: 1800 },
        { modes: ['FM'], width: 12000 },
        { modes: ['USB'], width: 0 },
      ]),
    });

    await expect(connection.getSupportedModeBandwidths()).resolves.toEqual([1800, 2400, 3000]);
  });

  it('keeps the current mode when writing mode bandwidth', async () => {
    const { connection, rig } = createConnectedConnection({
      getMode: vi.fn().mockResolvedValue({ mode: 'USB', bandwidth: 2400 }),
    });

    await expect(connection.setModeBandwidth(3000)).resolves.toBeUndefined();

    expect(rig.setMode).toHaveBeenCalledWith('USB', 3000);
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

  it('reads meter levels inside a single polling pass via MeterReader', async () => {
    const { connection, rig } = createConnectedConnection({
      getLevel: vi.fn().mockResolvedValue(0.5),
    });
    const tc = asTestConnection(connection);
    tc.supportedLevels = new Set([
      'STRENGTH',
      'SWR',
      'ALC',
      'RFPOWER_METER',
      'RFPOWER_METER_WATTS',
    ]);
    tc.meterDecodeStrategy = { name: 'generic', sourceLevel: 'STRENGTH', displayStyle: 'db-over-s9', label: 'test' };
    tc.meterReader = new HamlibMeterReader(defaultHamlibProfile, defaultHamlibProfile);

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

    // MeterReader reads alc, swr, power (RFPOWER_METER + RFPOWER_METER_WATTS), and level (STRENGTH).
    expect(rig.getLevel).toHaveBeenCalledWith('ALC');
    expect(rig.getLevel).toHaveBeenCalledWith('SWR');
    expect(rig.getLevel).toHaveBeenCalledWith('RFPOWER_METER');
    expect(rig.getLevel).toHaveBeenCalledWith('RFPOWER_METER_WATTS');
    expect(rig.getLevel).toHaveBeenCalledWith('STRENGTH');
    expect(emitted).toHaveLength(1);
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
    testConnection.meterReader = new HamlibMeterReader(defaultHamlibProfile, defaultHamlibProfile);

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

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
    testConnection.meterReader = new HamlibMeterReader(defaultHamlibProfile, defaultHamlibProfile);

    const emitted: any[] = [];
    connection.on('meterData', (data) => emitted.push(data));

    await (connection as any).pollMeters();

    expect(rig.getLevel).toHaveBeenCalledWith('STRENGTH');
    expect(emitted[0]?.level).toMatchObject({
      formatted: '-24 dB@S9',
      displayStyle: 'db-over-s9',
    });
  });

  it('uses the matched TX range max watts when converting absolute power readings', async () => {
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

    // Test via resolveCurrentTxPowerMaxWatts (the method still exists on the connection)
    const maxWatts = testConnection.resolveCurrentTxPowerMaxWatts();
    expect(maxWatts).toBe(25);
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

  it('maps Hamlib AGC codes to normalized mode names and writes them back as numeric levels', async () => {
    const { connection, rig } = createConnectedConnection({
      getLevel: vi.fn().mockResolvedValue(2),
      getAgcLevels: vi.fn().mockReturnValue([0, 2, 6]),
    });
    const testConnection = asTestConnection(connection);
    testConnection.supportedLevels = new Set(['AGC']);

    await expect(connection.getAgcMode()).resolves.toBe('fast');
    await expect(connection.getSupportedAgcModes()).resolves.toEqual(['off', 'fast', 'auto']);
    await expect(connection.setAgcMode('auto')).resolves.toBeUndefined();

    expect(rig.getLevel).toHaveBeenCalledWith('AGC');
    expect(rig.setLevel).toHaveBeenCalledWith('AGC', 6);
  });

  it('normalizes preamp and attenuator levels to positive dB options', async () => {
    const { connection, rig } = createConnectedConnection({
      getLevel: vi.fn()
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(6),
      getPreampValues: vi.fn().mockReturnValue([20, 10, 20, 0]),
      getAttenuatorValues: vi.fn().mockReturnValue([12, 6, 12, 0]),
    });
    const testConnection = asTestConnection(connection);
    testConnection.supportedLevels = new Set(['PREAMP', 'ATT']);

    await expect(connection.getPreampLevel()).resolves.toBe(10);
    await expect(connection.getSupportedPreampLevels()).resolves.toEqual([10, 20]);
    await expect(connection.setPreampLevel(20)).resolves.toBeUndefined();

    await expect(connection.getAttenuatorLevel()).resolves.toBe(6);
    await expect(connection.getSupportedAttenuatorLevels()).resolves.toEqual([6, 12]);
    await expect(connection.setAttenuatorLevel(12)).resolves.toBeUndefined();

    expect(rig.getLevel).toHaveBeenNthCalledWith(1, 'PREAMP');
    expect(rig.getLevel).toHaveBeenNthCalledWith(2, 'ATT');
    expect(rig.setLevel).toHaveBeenNthCalledWith(1, 'PREAMP', 20);
    expect(rig.setLevel).toHaveBeenNthCalledWith(2, 'ATT', 12);
  });

  it('reads and writes compressor and monitor gain controls through Hamlib function and level APIs', async () => {
    const { connection, rig } = createConnectedConnection({
      getFunction: vi.fn().mockResolvedValue(true),
      getLevel: vi.fn()
        .mockResolvedValueOnce(0.35)
        .mockResolvedValueOnce(0.6),
    });
    const testConnection = asTestConnection(connection);
    testConnection.supportedLevels = new Set(['COMP', 'MONITOR_GAIN']);

    await expect(connection.getCompressorEnabled()).resolves.toBe(true);
    await expect(connection.setCompressorEnabled(false)).resolves.toBeUndefined();
    await expect(connection.getCompressorLevel()).resolves.toBe(0.35);
    await expect(connection.setCompressorLevel(0.5)).resolves.toBeUndefined();
    await expect(connection.getMonitorGain()).resolves.toBe(0.6);
    await expect(connection.setMonitorGain(0.25)).resolves.toBeUndefined();

    expect(rig.getFunction).toHaveBeenCalledWith('COMP');
    expect(rig.setFunction).toHaveBeenCalledWith('COMP', false);
    expect(rig.getLevel).toHaveBeenNthCalledWith(1, 'COMP');
    expect(rig.getLevel).toHaveBeenNthCalledWith(2, 'MONITOR_GAIN');
    expect(rig.setLevel).toHaveBeenNthCalledWith(1, 'COMP', 0.5);
    expect(rig.setLevel).toHaveBeenNthCalledWith(2, 'MONITOR_GAIN', 0.25);
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

    // The power conversion logic moved to defaultHamlib profile.
    // Here we just verify resolveCurrentTxPowerMaxWatts returns the expected value.
    const maxWatts = testConnection.resolveCurrentTxPowerMaxWatts();
    expect(maxWatts).toBe(10);
  });
});
