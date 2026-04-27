import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RadioProfile } from '@tx5dr/contracts';
import { RadioPowerController } from '../RadioPowerController.js';
import { PhysicalRadioManager } from '../PhysicalRadioManager.js';
import { ConfigManager } from '../../config/config-manager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';

type MockLifecycle = {
  getIsRunning: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  startAndWaitForRunning: ReturnType<typeof vi.fn>;
};

type MockRadioManager = {
  withPowerOperation: <T>(reason: string, task: () => Promise<T>) => Promise<T>;
  wakeAndConnect: ReturnType<typeof vi.fn>;
  getActiveConnection: ReturnType<typeof vi.fn>;
  markIntentionalDisconnect: ReturnType<typeof vi.fn>;
  clearIntentionalDisconnect: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  applyConfig: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function resetControllerSingleton(): void {
  (RadioPowerController as unknown as { instance: RadioPowerController | null }).instance = null;
}

function createProfile(): RadioProfile {
  return {
    id: 'profile-ft710',
    name: 'FT-710',
    radio: {
      type: 'serial',
      serial: { path: 'COM3', rigModel: 1049 },
    },
    audio: {},
    audioLockedToRadio: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function installConfig(profile = createProfile()): void {
  const cfg = ConfigManager.getInstance() as unknown as {
    config: { profiles: RadioProfile[]; activeProfileId: string };
  };
  cfg.config = {
    profiles: [profile],
    activeProfileId: profile.id,
  };
}

function createController(options?: {
  connection?: { setPowerState?: ReturnType<typeof vi.fn> };
  connected?: boolean;
  running?: boolean;
  wakeAndConnect?: ReturnType<typeof vi.fn>;
}) {
  resetControllerSingleton();
  installConfig();

  const lifecycle: MockLifecycle = {
    getIsRunning: vi.fn().mockReturnValue(options?.running ?? false),
    stop: vi.fn().mockResolvedValue(undefined),
    startAndWaitForRunning: vi.fn().mockResolvedValue(undefined),
  };
  const connection = options?.connection ?? { setPowerState: vi.fn().mockResolvedValue(undefined) };
  const radioManager: MockRadioManager = {
    withPowerOperation: async <T>(_reason: string, task: () => Promise<T>) => task(),
    wakeAndConnect: options?.wakeAndConnect ?? vi.fn().mockResolvedValue(undefined),
    getActiveConnection: vi.fn().mockReturnValue(connection),
    markIntentionalDisconnect: vi.fn(),
    clearIntentionalDisconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(options?.connected ?? true),
    applyConfig: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  const controller = RadioPowerController.create({
    radioManager: radioManager as never,
    getEngineLifecycle: () => lifecycle as never,
  });

  return { controller, lifecycle, radioManager, connection };
}

function unsupportedPowerError(): RadioError {
  return new RadioError({
    code: RadioErrorCode.INVALID_OPERATION,
    message: 'Optional radio operation unavailable (setPowerState): Invalid parameter',
    userMessage: 'Radio operation is not supported by this model',
    severity: RadioErrorSeverity.WARNING,
    context: { operation: 'setPowerState', optional: true, recoverable: true },
  });
}

describe('RadioPowerController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetControllerSingleton();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetControllerSingleton();
  });

  it('does not expose operate for FT-710 power support', async () => {
    installConfig();
    vi.spyOn(PhysicalRadioManager, 'listSupportedRigs').mockResolvedValue([
      { rigModel: 1049, mfgName: 'Yaesu', modelName: 'FT-710' },
    ] as never);
    const { controller } = createController();

    const support = await controller.getSupportInfo('profile-ft710');

    expect(support.canPowerOn).toBe(true);
    expect(support.canPowerOff).toBe(true);
    expect(support.supportedStates).toEqual(['off']);
  });

  it('does not stop the engine or disconnect when operate is unsupported', async () => {
    const setPowerState = vi.fn().mockRejectedValue(unsupportedPowerError());
    const { controller, lifecycle, radioManager } = createController({
      connection: { setPowerState },
      running: true,
    });
    const events: unknown[] = [];
    controller.on('powerState', (event) => events.push(event));

    await expect(controller.handleRequest({
      profileId: 'profile-ft710',
      state: 'operate',
      autoEngine: true,
    })).rejects.toThrow('Invalid parameter');

    expect(setPowerState).toHaveBeenCalledWith('operate');
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(radioManager.disconnect).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      state: 'failed',
      errorKey: 'radio:power.error.notSupported',
    }));
  });

  it('keeps the current session when off is unsupported', async () => {
    const setPowerState = vi.fn().mockRejectedValue(unsupportedPowerError());
    const { controller, lifecycle, radioManager } = createController({
      connection: { setPowerState },
      running: true,
    });

    await expect(controller.handleRequest({
      profileId: 'profile-ft710',
      state: 'off',
      autoEngine: true,
    })).rejects.toThrow('Invalid parameter');

    expect(radioManager.markIntentionalDisconnect).toHaveBeenCalledWith('power off');
    expect(radioManager.clearIntentionalDisconnect).toHaveBeenCalledTimes(1);
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(radioManager.disconnect).not.toHaveBeenCalled();
  });

  it('stops engine resources only after off command succeeds', async () => {
    vi.useFakeTimers();
    const setPowerState = vi.fn().mockResolvedValue(undefined);
    const { controller, lifecycle } = createController({
      connection: { setPowerState },
      running: true,
    });

    const pending = controller.handleRequest({
      profileId: 'profile-ft710',
      state: 'off',
      autoEngine: true,
    });
    expect(lifecycle.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe('off');

    expect(setPowerState).toHaveBeenCalledWith('off');
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  it('opens a CAT link for off when the engine is already stopped and disconnected', async () => {
    vi.useFakeTimers();
    const setPowerState = vi.fn().mockResolvedValue(undefined);
    const { controller, lifecycle, radioManager } = createController({
      connection: { setPowerState },
      connected: false,
      running: false,
    });
    radioManager.isConnected
      .mockReturnValueOnce(false) // ensureCatLinkForPowerCommand
      .mockReturnValue(true);

    const pending = controller.handleRequest({
      profileId: 'profile-ft710',
      state: 'off',
      autoEngine: true,
    });

    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe('off');

    expect(radioManager.applyConfig).toHaveBeenCalledTimes(1);
    expect(setPowerState).toHaveBeenCalledWith('off');
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(radioManager.disconnect).toHaveBeenCalledWith('power off');
  });

  it('treats an immediate CAT disconnect during off as a confirmed physical transition', async () => {
    vi.useFakeTimers();
    const setPowerState = vi.fn().mockRejectedValue(new Error('current state: disconnected'));
    const { controller, lifecycle, radioManager } = createController({
      connection: { setPowerState },
      running: true,
    });

    const pending = controller.handleRequest({
      profileId: 'profile-ft710',
      state: 'off',
      autoEngine: true,
    });

    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe('off');

    expect(radioManager.clearIntentionalDisconnect).not.toHaveBeenCalled();
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  it('starts the software engine after physical power-on when autoEngine is true', async () => {
    const order: string[] = [];
    const wakeAndConnect = vi.fn().mockImplementation(async () => {
      order.push('wake');
    });
    const { controller, lifecycle } = createController({ wakeAndConnect });
    lifecycle.startAndWaitForRunning.mockImplementation(async () => {
      order.push('engine');
    });

    await expect(controller.handleRequest({
      profileId: 'profile-ft710',
      state: 'on',
      autoEngine: true,
    })).resolves.toBe('awake');

    expect(order).toEqual(['wake', 'engine']);
  });

  it('does not start the software engine after physical power-on when autoEngine is false', async () => {
    const { controller, lifecycle, radioManager } = createController();

    await expect(controller.handleRequest({
      profileId: 'profile-ft710',
      state: 'on',
      autoEngine: false,
    })).resolves.toBe('awake');

    expect(radioManager.wakeAndConnect).toHaveBeenCalledTimes(1);
    expect(lifecycle.startAndWaitForRunning).not.toHaveBeenCalled();
  });
});
