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
};

function createConnectedConnection(rigOverrides: Partial<MockRig> = {}): {
  connection: HamlibConnection;
  rig: MockRig;
} {
  const connection = new HamlibConnection();
  const rig: MockRig = {
    setFrequency: vi.fn().mockResolvedValue(0),
    getSplit: vi.fn().mockResolvedValue({ enabled: false }),
    setSplitFreq: vi.fn().mockResolvedValue(0),
    ...rigOverrides,
  };

  (connection as any).rig = rig;
  (connection as any).state = RadioConnectionState.CONNECTED;

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
});
