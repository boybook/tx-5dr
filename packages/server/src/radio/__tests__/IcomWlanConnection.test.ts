import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('icom-wlan-node', () => ({
  IcomControl: class MockIcomControl {},
  AUDIO_RATE: 48000,
}));

import { IcomWlanConnection } from '../connections/IcomWlanConnection.js';
import { RadioConnectionState } from '../connections/IRadioConnection.js';

type MockRig = {
  setMode: ReturnType<typeof vi.fn>;
};

type IcomWlanConnectionTestAccessor = {
  rig: MockRig;
  state: RadioConnectionState;
  defaultDataMode: boolean;
};

function asTestConnection(connection: IcomWlanConnection): IcomWlanConnectionTestAccessor {
  return connection as unknown as IcomWlanConnectionTestAccessor;
}

function createConnectedConnection(): { connection: IcomWlanConnection; rig: MockRig } {
  const connection = new IcomWlanConnection();
  const rig: MockRig = {
    setMode: vi.fn().mockResolvedValue(undefined),
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
});
