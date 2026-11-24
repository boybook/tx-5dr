import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODES, type ModeDescriptor, type RadioProfile } from '@tx5dr/contracts';
import { ConfigManager } from '../config-manager.js';
import { ProfileManager } from '../ProfileManager.js';
import { RuntimeStateManager } from '../RuntimeStateManager.js';
import { DigitalRadioEngine } from '../../DigitalRadioEngine.js';
import { EngineState } from '../../state-machines/types.js';
import { PersistenceCoordinator } from '../../utils/persistence/index.js';

type EngineMode = 'digital' | 'voice' | 'cw' | 'rtty' | 'image';

function resetSingletons(): void {
  (ConfigManager as unknown as { instance?: ConfigManager | null }).instance = null;
  RuntimeStateManager.getInstance().disposeForTests();
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
  PersistenceCoordinator.getInstance().allowNewMutationsForTests();
  (ProfileManager as unknown as { instance?: ProfileManager }).instance = undefined;
}

function makeProfile(id: string, name: string, createdAt: number): RadioProfile {
  return {
    id,
    name,
    radio: { type: 'serial' } as RadioProfile['radio'],
    audio: {
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
    },
    audioLockedToRadio: false,
    createdAt,
    updatedAt: createdAt,
  } as RadioProfile;
}

/**
 * A stopped engine built on the production prototype. Only the runtime collaborators
 * that would touch audio, CAT or workers are replaced, so the mode bookkeeping under
 * test is the engine's own.
 */
function createStoppedEngine(initial: { engineMode: EngineMode; mode: ModeDescriptor }) {
  const startedWith: Array<{ engineMode: EngineMode; mode: string }> = [];
  const resourcePlans: string[] = [];
  const operatorSetMode = vi.fn();

  const engine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
    engineMode: initial.engineMode,
    currentMode: initial.mode,
    modeSwitchTail: Promise.resolve(),
    engineLifecycle: {
      getEngineState: vi.fn(() => EngineState.IDLE),
      rebuildResourcePlan: vi.fn(async () => {
        resourcePlans.push((engine as { currentMode: ModeDescriptor }).currentMode.name);
      }),
    },
    getStatus: vi.fn(() => ({ isRunning: true, engineState: EngineState.RUNNING })),
    stop: vi.fn(async () => undefined),
    start: vi.fn(async () => {
      const state = engine as { engineMode: EngineMode; currentMode: ModeDescriptor };
      startedWith.push({ engineMode: state.engineMode, mode: state.currentMode.name });
    }),
    emit: vi.fn(),
    emitModeAndStatusSnapshot: vi.fn(),
    getAudioStreamManager: vi.fn(() => ({ reloadAudioConfig: vi.fn() })),
    applyDecodeWindowOverrides: vi.fn(),
    stopCWDecoderRuntime: vi.fn(async () => undefined),
    cwKeyerManager: { stopActive: vi.fn(async () => undefined) },
    voiceKeyerManager: { stopActive: vi.fn(async () => undefined) },
    rttyService: { abort: vi.fn(async () => undefined) },
    slotClock: { setMode: vi.fn() },
    slotPackManager: { setMode: vi.fn() },
    clockCoordinator: { onModeChanged: vi.fn() },
    _operatorManager: { getAllOperators: vi.fn(() => [{ setMode: operatorSetMode }]) },
  });

  vi.spyOn(DigitalRadioEngine, 'getInstance').mockReturnValue(engine as DigitalRadioEngine);

  return { engine, startedWith, resourcePlans, operatorSetMode };
}

describe('ProfileManager.activateProfile engine mode', () => {
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  const previousDataDir = process.env.TX5DR_DATA_DIR;
  let configDir: string;
  let configManager: ConfigManager;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-profile-engine-mode-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    process.env.TX5DR_DATA_DIR = configDir;
    resetSingletons();
    configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await configManager.addProfile(makeProfile('ft8-radio', 'FT8 radio', 1));
    await configManager.addProfile(makeProfile('cw-radio', 'CW radio', 2));

    // The CW radio was last used in CW; the FT8 radio was last used in FT4.
    await configManager.setActiveProfileId('cw-radio');
    await configManager.setLastEngineMode('cw');
    await configManager.switchActiveProfile('ft8-radio');
    await configManager.setLastEngineMode('digital');
    await configManager.setLastDigitalModeName('FT4');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await RuntimeStateManager.getInstance().flush();
    resetSingletons();
    if (previousConfigDir === undefined) {
      delete process.env.TX5DR_CONFIG_DIR;
    } else {
      process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    }
    if (previousDataDir === undefined) {
      delete process.env.TX5DR_DATA_DIR;
    } else {
      process.env.TX5DR_DATA_DIR = previousDataDir;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  it('starts the engine in the remembered CW mode of the activated Profile', async () => {
    // Regression: the engine kept running FT8 while lastEngineMode said "cw", so the
    // radio bootstrap keyed CW and the next server restart came back in CW.
    const { engine, startedWith, resourcePlans, operatorSetMode } = createStoppedEngine({
      engineMode: 'digital',
      mode: MODES.FT4,
    });

    await ProfileManager.getInstance().activateProfile('cw-radio');

    expect(configManager.getLastEngineMode()).toBe('cw');
    expect(startedWith).toEqual([{ engineMode: 'cw', mode: 'CW' }]);
    expect(engine.getEngineMode()).toBe(configManager.getLastEngineMode());
    expect(resourcePlans).toEqual(['CW']);
    expect(operatorSetMode).toHaveBeenCalledWith(MODES.CW);
    expect(engine.emitModeAndStatusSnapshot).toHaveBeenCalled();
  });

  it('returns to the remembered digital mode when leaving a CW Profile', async () => {
    await configManager.switchActiveProfile('cw-radio');
    const { engine, startedWith, resourcePlans } = createStoppedEngine({
      engineMode: 'cw',
      mode: MODES.CW,
    });

    await ProfileManager.getInstance().activateProfile('ft8-radio');

    expect(configManager.getLastEngineMode()).toBe('digital');
    expect(startedWith).toEqual([{ engineMode: 'digital', mode: 'FT4' }]);
    expect(engine.getEngineMode()).toBe('digital');
    expect(resourcePlans).toEqual(['FT4']);
    expect(engine.stopCWDecoderRuntime).toHaveBeenCalledWith('leaving-cw-mode');
    expect(engine.applyDecodeWindowOverrides).toHaveBeenCalled();
  });

  it('keeps the running mode when the same Profile is re-activated after an edit', async () => {
    const { engine, startedWith, resourcePlans } = createStoppedEngine({
      engineMode: 'digital',
      mode: MODES.FT4,
    });

    await ProfileManager.getInstance().activateProfile('ft8-radio');

    expect(startedWith).toEqual([{ engineMode: 'digital', mode: 'FT4' }]);
    expect(resourcePlans).toEqual([]);
    expect(engine.emitModeAndStatusSnapshot).not.toHaveBeenCalled();
  });
});
