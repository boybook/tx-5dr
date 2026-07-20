import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioProfile } from '@tx5dr/contracts';

const { state, configManager } = vi.hoisted(() => {
  const testState = {
    activeProfileId: 'profile-a' as string | null,
    profiles: [] as RadioProfile[],
  };
  return {
    state: testState,
    configManager: {
      getActiveProfileId: vi.fn(() => testState.activeProfileId),
      getProfile: vi.fn((id: string) => testState.profiles.find((profile) => profile.id === id) ?? null),
      setActiveProfileId: vi.fn(async (id: string | null) => {
        testState.activeProfileId = id;
      }),
    },
  };
});

vi.mock('../config-manager.js', () => ({
  ConfigManager: { getInstance: () => configManager },
}));

import {
  ProfileActivationCoordinator,
  type ProfileActivationCoordinatorDeps,
} from '../ProfileActivationCoordinator.js';

function makeProfile(id: string): RadioProfile {
  return {
    id,
    name: id,
    radio: { type: 'none' },
    audio: {
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
    },
    audioLockedToRadio: false,
    createdAt: 1,
    updatedAt: 1,
  } as RadioProfile;
}

function createDeps(overrides: Partial<ProfileActivationCoordinatorDeps> = {}) {
  let running = true;
  let connected = false;
  const deps: ProfileActivationCoordinatorDeps = {
    isEngineRunning: vi.fn(() => running),
    stopEngine: vi.fn(async () => {
      running = false;
    }),
    startEngine: vi.fn(async () => {
      running = true;
    }),
    isRadioConnected: vi.fn(() => connected),
    markIntentionalDisconnect: vi.fn(() => ({ id: 1 })),
    clearIntentionalDisconnect: vi.fn(),
    disconnectRadio: vi.fn(async () => {
      connected = false;
    }),
    applyProfileContext: vi.fn(),
    reloadAudioConfig: vi.fn(),
    getEngineMode: vi.fn(() => 'digital'),
    getCurrentMode: vi.fn(() => ({
      name: 'FT8',
      slotMs: 15_000,
      toleranceMs: 100,
      windowTiming: [-3_200, -1_500, -300],
      transmitTiming: 500,
      encodeAdvance: 0,
    })),
    emitProfileChanged: vi.fn(),
    ...overrides,
  };
  return deps;
}

describe('ProfileActivationCoordinator', () => {
  beforeEach(() => {
    state.activeProfileId = 'profile-a';
    state.profiles = [makeProfile('profile-a'), makeProfile('profile-b'), makeProfile('profile-c')];
    vi.clearAllMocks();
  });

  it('commits the active Profile only after stopping and broadcasts after applying context', async () => {
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);

    await coordinator.activate('profile-b', { restartEngine: true });

    expect(configManager.setActiveProfileId).toHaveBeenCalledWith('profile-b');
    expect(deps.stopEngine).toHaveBeenCalledTimes(1);
    expect(deps.applyProfileContext).toHaveBeenCalledTimes(1);
    expect(deps.reloadAudioConfig).toHaveBeenCalledTimes(1);
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
    expect(deps.emitProfileChanged).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-b',
      previousProfileId: 'profile-a',
      engineMode: 'digital',
      currentMode: expect.objectContaining({ name: 'FT8' }),
    }));
    expect(vi.mocked(deps.stopEngine).mock.invocationCallOrder[0])
      .toBeLessThan(configManager.setActiveProfileId.mock.invocationCallOrder[0]);
    expect(vi.mocked(deps.reloadAudioConfig).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.emitProfileChanged).mock.invocationCallOrder[0]);
    expect(vi.mocked(deps.emitProfileChanged).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.startEngine).mock.invocationCallOrder[0]);
  });

  it('does not switch or broadcast when stopping the old engine fails', async () => {
    const deps = createDeps({
      stopEngine: vi.fn(async () => {
        throw new Error('stop failed');
      }),
    });
    const coordinator = new ProfileActivationCoordinator(deps);

    await expect(coordinator.activate('profile-b', { restartEngine: false }))
      .rejects.toThrow('stop failed');

    expect(state.activeProfileId).toBe('profile-a');
    expect(configManager.setActiveProfileId).not.toHaveBeenCalled();
    expect(deps.applyProfileContext).not.toHaveBeenCalled();
    expect(deps.emitProfileChanged).not.toHaveBeenCalled();
  });

  it('serializes concurrent activations', async () => {
    let releaseStop!: () => void;
    let running = true;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = () => {
        running = false;
        resolve();
      };
    });
    const deps = createDeps({
      isEngineRunning: vi.fn(() => running),
      stopEngine: vi.fn(() => stopGate),
    });
    const coordinator = new ProfileActivationCoordinator(deps);

    const first = coordinator.activate('profile-b', { restartEngine: false });
    const second = coordinator.activate('profile-c', { restartEngine: false });
    await Promise.resolve();
    expect(configManager.setActiveProfileId).not.toHaveBeenCalled();

    releaseStop();
    await Promise.all([first, second]);

    expect(configManager.setActiveProfileId.mock.calls).toEqual([
      ['profile-b'],
      ['profile-c'],
    ]);
    expect(state.activeProfileId).toBe('profile-c');
  });

  it('does not release the transition lock at an outer stop timeout boundary', async () => {
    vi.useFakeTimers();
    let running = true;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = () => {
        running = false;
        resolve();
      };
    });
    const deps = createDeps({
      isEngineRunning: vi.fn(() => running),
      stopEngine: vi.fn(() => stopGate),
    });
    const coordinator = new ProfileActivationCoordinator(deps);
    const activation = coordinator.activate('profile-b', { restartEngine: false });
    const queuedWork = vi.fn().mockResolvedValue(undefined);
    const queued = coordinator.runExclusive(queuedWork);

    await vi.advanceTimersByTimeAsync(10_001);
    expect(queuedWork).not.toHaveBeenCalled();
    expect(configManager.setActiveProfileId).not.toHaveBeenCalled();

    releaseStop();
    await Promise.all([activation, queued]);
    expect(queuedWork).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('holds the transition lock until Profile engine startup completes', async () => {
    let running = true;
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = () => {
        running = true;
        resolve();
      };
    });
    const deps = createDeps({
      isEngineRunning: vi.fn(() => running),
      stopEngine: vi.fn(async () => {
        running = false;
      }),
      startEngine: vi.fn(() => startupGate),
    });
    const coordinator = new ProfileActivationCoordinator(deps);

    const first = coordinator.activate('profile-b', { restartEngine: true });
    const second = coordinator.activate('profile-c', { restartEngine: false });
    await vi.waitFor(() => {
      expect(configManager.setActiveProfileId).toHaveBeenCalledTimes(1);
      expect(deps.startEngine).toHaveBeenCalledTimes(1);
    });

    expect(configManager.setActiveProfileId).toHaveBeenLastCalledWith('profile-b');
    releaseStartup();
    await Promise.all([first, second]);

    expect(configManager.setActiveProfileId.mock.calls).toEqual([
      ['profile-b'],
      ['profile-c'],
    ]);
    expect(deps.stopEngine).toHaveBeenCalledTimes(2);
  });

  it('serializes engine mode work with Profile activation', async () => {
    let releaseModeWork!: () => void;
    const modeWorkGate = new Promise<void>((resolve) => {
      releaseModeWork = resolve;
    });
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);

    const modeWork = coordinator.runExclusive(() => modeWorkGate);
    const activation = coordinator.activate('profile-b', { restartEngine: false });
    await Promise.resolve();

    expect(configManager.setActiveProfileId).not.toHaveBeenCalled();
    releaseModeWork();
    await Promise.all([modeWork, activation]);

    expect(configManager.setActiveProfileId).toHaveBeenCalledWith('profile-b');
  });

  it('holds the transition lock for work that follows Profile activation', async () => {
    let releasePowerWork!: () => void;
    const powerWorkGate = new Promise<void>((resolve) => {
      releasePowerWork = resolve;
    });
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);

    const powerWork = coordinator.activateAndRun(
      'profile-b',
      { restartEngine: false, allowProfileActivation: true },
      () => powerWorkGate,
    );
    const modeWork = vi.fn().mockResolvedValue(undefined);
    const queuedModeWork = coordinator.runExclusive(modeWork);
    await vi.waitFor(() => {
      expect(configManager.setActiveProfileId).toHaveBeenCalledWith('profile-b');
    });

    expect(modeWork).not.toHaveBeenCalled();
    releasePowerWork();
    await Promise.all([powerWork, queuedModeWork]);
    expect(modeWork).toHaveBeenCalledTimes(1);
  });

  it('leaves the engine stopped for power workflows', async () => {
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);

    const result = await coordinator.activate('profile-b', { restartEngine: false });

    expect(deps.stopEngine).toHaveBeenCalledTimes(1);
    expect(deps.startEngine).not.toHaveBeenCalled();
    expect(result.engineRunning).toBe(false);
    expect(result.generation).toBe(1);
    expect(deps.emitProfileChanged).toHaveBeenCalledWith(expect.objectContaining({
      generation: 1,
    }));
  });

  it('returns a partial activation result when engine startup fails', async () => {
    const deps = createDeps({
      startEngine: vi.fn(async () => {
        throw new Error('audio device unavailable');
      }),
    });
    const coordinator = new ProfileActivationCoordinator(deps);

    const result = await coordinator.activate('profile-b', { restartEngine: true });

    expect(state.activeProfileId).toBe('profile-b');
    expect(result).toMatchObject({
      profile: expect.objectContaining({ id: 'profile-b' }),
      engineRunning: false,
      error: 'audio device unavailable',
    });
  });

  it('does not mark an intentional disconnect when no radio is connected', async () => {
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);

    await coordinator.activate('profile-b', { restartEngine: false });

    expect(deps.markIntentionalDisconnect).not.toHaveBeenCalled();
    expect(deps.clearIntentionalDisconnect).not.toHaveBeenCalled();
  });

  it('clears an unconsumed intentional disconnect token after disconnect failure', async () => {
    const token = { id: 42 };
    const deps = createDeps({
      isEngineRunning: vi.fn(() => false),
      isRadioConnected: vi.fn(() => true),
      markIntentionalDisconnect: vi.fn(() => token),
      disconnectRadio: vi.fn(async () => {
        throw new Error('disconnect failed');
      }),
    });
    const coordinator = new ProfileActivationCoordinator(deps);

    await expect(coordinator.activate('profile-b', { restartEngine: false }))
      .rejects.toThrow('disconnect failed');

    expect(deps.markIntentionalDisconnect).toHaveBeenCalledTimes(1);
    expect(deps.clearIntentionalDisconnect).toHaveBeenCalledWith(token);
    expect(state.activeProfileId).toBe('profile-a');
  });

  it('refreshes same-Profile runtime context only when explicitly requested', async () => {
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);

    await coordinator.activateAndRun(
      'profile-a',
      { restartEngine: false, refreshContext: true, allowProfileActivation: false },
      async () => undefined,
    );

    expect(configManager.setActiveProfileId).not.toHaveBeenCalled();
    expect(deps.applyProfileContext).toHaveBeenCalledTimes(1);
    expect(deps.reloadAudioConfig).toHaveBeenCalledTimes(1);
    expect(deps.emitProfileChanged).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-a',
      previousProfileId: 'profile-a',
      engineMode: 'digital',
      currentMode: expect.objectContaining({ name: 'FT8' }),
    }));
  });

  it('rechecks cross-Profile authorization after waiting for the transition lock', async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);
    const held = coordinator.runExclusive(() => blocker);
    const task = vi.fn().mockResolvedValue(undefined);
    const queued = coordinator.activateAndRun(
      'profile-a',
      { restartEngine: false, allowProfileActivation: false },
      task,
    );

    state.activeProfileId = 'profile-b';
    releaseBlocker();
    await held;
    await expect(queued).rejects.toMatchObject({
      context: expect.objectContaining({ reason: 'profile-activation-not-authorized' }),
    });

    expect(task).not.toHaveBeenCalled();
    expect(configManager.setActiveProfileId).not.toHaveBeenCalled();
  });

  it('serializes Profile mutations behind an active power task', async () => {
    let releasePower!: () => void;
    const powerGate = new Promise<void>((resolve) => {
      releasePower = resolve;
    });
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);
    const power = coordinator.activateAndRun(
      'profile-a',
      { restartEngine: false, allowProfileActivation: false },
      () => powerGate,
    );
    const mutateProfile = vi.fn(() => {
      state.profiles[0] = { ...state.profiles[0]!, name: 'updated' };
    });
    const mutation = coordinator.runExclusive(async () => mutateProfile());

    await Promise.resolve();
    expect(mutateProfile).not.toHaveBeenCalled();
    releasePower();
    await Promise.all([power, mutation]);
    expect(mutateProfile).toHaveBeenCalledTimes(1);
  });

  it('passes an isolated Profile snapshot to a power task', async () => {
    const deps = createDeps();
    const coordinator = new ProfileActivationCoordinator(deps);

    const snapshot = await coordinator.activateAndRun(
      'profile-a',
      { restartEngine: false, allowProfileActivation: false },
      async (profile) => profile,
    );
    snapshot.name = 'mutated task copy';

    expect(state.profiles[0]?.name).toBe('profile-a');
  });
});
