import { describe, expect, it } from 'vitest';
import { DeviceUiProjectionService } from '../DeviceUiProjectionService.js';

function engine(status: Record<string, unknown> = {}) {
  return {
    getStatus: () => ({ isRunning: true, engineState: 'running', radioConnected: true, nextSlotIn: 4000, currentMode: { name: 'FT8' }, ...status }),
  };
}

describe('DeviceUiProjectionService', () => {
  it('reads browser client count only from the ordinary WSServer projection', () => {
    const projection = new DeviceUiProjectionService(engine() as never, { getBrowserClientCount: () => 2 } as never);
    expect(projection.getModel().access.browserClientCount).toBe(2);
  });

  it('projects a small safe radio model', () => {
    const projection = new DeviceUiProjectionService(engine({ radioConnected: false, engineState: 'idle' }) as never, { getBrowserClientCount: () => 0 } as never);
    const model = projection.getModel();
    expect(model.radio).toMatchObject({ serverConnected: true, engineState: 'idle', radioConnected: false });
    expect(JSON.stringify(model)).not.toContain('token');
  });
});
