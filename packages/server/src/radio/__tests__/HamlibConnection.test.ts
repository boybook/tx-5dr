import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('hamlib', () => ({
  HamLib: class MockHamLib {},
}));

vi.mock('hamlib/spectrum', () => ({
  SpectrumController: class MockSpectrumController {},
}));

import { HamlibConnection } from '../connections/HamlibConnection.js';
import { RadioConnectionState } from '../connections/IRadioConnection.js';

type MockRig = {
  setFrequency: ReturnType<typeof vi.fn>;
  getSplit: ReturnType<typeof vi.fn>;
  setSplitFreq: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  getFrequency: ReturnType<typeof vi.fn>;
  getMode: ReturnType<typeof vi.fn>;
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
    getFrequency: vi.fn().mockResolvedValue(7100000),
    getMode: vi.fn().mockResolvedValue({ mode: 'USB', bandwidth: 'wide' }),
    ...rigOverrides,
  };
  const testConnection = asTestConnection(connection);

  testConnection.rig = rig;
  testConnection.state = RadioConnectionState.CONNECTED;

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
