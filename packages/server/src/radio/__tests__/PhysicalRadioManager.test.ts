import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('hamlib', () => ({
  HamLib: class MockHamLib {},
}));

vi.mock('icom-wlan-node', () => ({
  IcomControl: class MockIcomControl {},
  AUDIO_RATE: 48000,
}));

import { PhysicalRadioManager } from '../PhysicalRadioManager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';

describe('PhysicalRadioManager', () => {
  let manager: PhysicalRadioManager;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    manager = new PhysicalRadioManager();
    send = vi.fn();
    (manager as any).radioActor = { send };
  });

  it('does not report recoverable getMode failures as connection health failures', async () => {
    (manager as any).connection = {
      getMode: vi.fn().mockRejectedValue(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (getMode): Feature not available',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        context: { operation: 'getMode', optional: true, recoverable: true },
      })),
    };

    await expect(manager.getMode()).rejects.toThrow(
      'get mode failed: Optional radio operation unavailable (getMode): Feature not available'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('still reports real getMode failures to the connection health state machine', async () => {
    (manager as any).connection = {
      getMode: vi.fn().mockRejectedValue(new Error('device disconnected')),
    };

    await expect(manager.getMode()).rejects.toThrow('get mode failed: device disconnected');
    expect(send).toHaveBeenCalledWith({
      type: 'HEALTH_CHECK_FAILED',
      error: expect.any(Error),
    });
  });
});
