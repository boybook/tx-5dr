import type { EngineMode, ModeDescriptor, RadioProfile } from '@tx5dr/contracts';
import { ConfigManager } from './config-manager.js';
import { createLogger } from '../utils/logger.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

const logger = createLogger('ProfileActivationCoordinator');

export interface ProfileDisconnectIntent {
  readonly id: number;
}

export interface ProfileActivationCoordinatorDeps {
  isEngineRunning(): boolean;
  stopEngine(): Promise<void>;
  startEngine(): Promise<void>;
  isRadioConnected(): boolean;
  markIntentionalDisconnect(reason: string): ProfileDisconnectIntent;
  clearIntentionalDisconnect(intent: ProfileDisconnectIntent): void;
  disconnectRadio(reason: string): Promise<void>;
  applyProfileContext(): void;
  reloadAudioConfig(): void;
  getEngineMode(): EngineMode;
  getCurrentMode(): ModeDescriptor;
  emitProfileChanged(data: {
    profileId: string;
    profile: RadioProfile;
    previousProfileId: string | null;
    wasRunning: boolean;
    generation: number;
    engineMode: EngineMode;
    currentMode: ModeDescriptor;
  }): void;
}

export interface ProfileActivationOptions {
  restartEngine: boolean;
  /** Re-project the active Profile without changing its durable pointer. */
  refreshContext?: boolean;
}

export interface ProfileActivationRunOptions extends ProfileActivationOptions {
  /** Whether this caller may change the durable active Profile pointer. */
  allowProfileActivation: boolean;
}

export interface ProfileActivationResult {
  profile: RadioProfile;
  previousProfileId: string | null;
  wasRunning: boolean;
  engineRunning: boolean;
  generation: number;
  error?: string;
}

export class ProfileActivationCoordinator {
  private transitionTail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly deps: ProfileActivationCoordinatorDeps) {}

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.transitionTail;
    let release!: () => void;
    this.transitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  async activate(profileId: string, options: ProfileActivationOptions): Promise<ProfileActivationResult> {
    return this.runExclusive(() => this.activateExclusive(profileId, options));
  }

  async activateAndRun<T>(
    profileId: string,
    options: ProfileActivationRunOptions,
    task: (profile: RadioProfile) => Promise<T>,
  ): Promise<T> {
    return this.runExclusive(async () => {
      const configManager = ConfigManager.getInstance();
      if (configManager.getActiveProfileId() !== profileId) {
        if (!options.allowProfileActivation) {
          throw this.profileActivationDenied(profileId, configManager.getActiveProfileId());
        }
        await this.activateExclusive(profileId, options);
      } else if (options.refreshContext) {
        const profile = this.requireProfileSnapshot(profileId);
        this.generation += 1;
        this.projectProfileContext(profile, profileId, this.deps.isEngineRunning());
      }

      // Resolve after waiting for the transition lock. Profile edits use this
      // same coordinator, so the power/radio task cannot observe stale config.
      return task(this.requireProfileSnapshot(profileId));
    });
  }

  private async activateExclusive(
    profileId: string,
    options: ProfileActivationOptions,
  ): Promise<ProfileActivationResult> {
    const configManager = ConfigManager.getInstance();
    this.requireProfile(profileId);

    const previousProfileId = configManager.getActiveProfileId();
    const wasRunning = this.deps.isEngineRunning();

    const reason = `profile switch ${previousProfileId ?? '(none)'} -> ${profileId}`;
    if (wasRunning) {
      await this.withDisconnectIntentIfConnected(reason, () => this.stopEngineAndWait());
    }
    if (this.deps.isRadioConnected()) {
      await this.withDisconnectIntentIfConnected(reason, () => this.deps.disconnectRadio(reason));
    }

    // Operating state is already keyed by Profile, so committing the pointer is
    // the only state transition. No global snapshot/load window exists.
    await configManager.setActiveProfileId(profileId);
    const profile = this.requireProfileSnapshot(profileId);
    this.generation += 1;
    this.projectProfileContext(profile, previousProfileId, wasRunning);

    let engineRunning = false;
    let activationError: string | undefined;
    if (options.restartEngine) {
      try {
        await this.deps.startEngine();
        engineRunning = this.deps.isEngineRunning();
        if (!engineRunning) {
          throw new Error('Engine did not reach the running state');
        }
      } catch (error) {
        logger.error('Engine start failed after Profile activation', error);
        activationError = this.errorMessage(error);
        if (this.deps.isEngineRunning()) {
          try {
            await this.withDisconnectIntentIfConnected(
              `profile ${profileId} startup cleanup`,
              () => this.stopEngineAndWait(),
            );
          } catch (stopError) {
            logger.error('Failed to settle engine after Profile activation start failure', stopError);
            activationError += `; cleanup failed: ${this.errorMessage(stopError)}`;
          }
        }
        engineRunning = this.deps.isEngineRunning();
      }
    }

    logger.info('Profile context activated', {
      profileId,
      previousProfileId,
      engineRunning,
      generation: this.generation,
      ...(activationError ? { error: activationError } : {}),
    });

    return {
      profile,
      previousProfileId,
      wasRunning,
      engineRunning,
      generation: this.generation,
      ...(activationError ? { error: activationError } : {}),
    };
  }

  private async stopEngineAndWait(): Promise<void> {
    // The engine lifecycle owns its terminal-state timeout. Releasing the
    // Profile lock before that stop settles would allow a new transaction to
    // race resource teardown from the previous Profile.
    await this.deps.stopEngine();
  }

  private requireProfile(profileId: string): RadioProfile {
    const profile = ConfigManager.getInstance().getProfile(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} does not exist`);
    }
    return profile;
  }

  private requireProfileSnapshot(profileId: string): RadioProfile {
    return structuredClone(this.requireProfile(profileId));
  }

  private profileActivationDenied(profileId: string, activeProfileId: string | null): RadioError {
    return new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: `Power operation may not activate Profile ${profileId}`,
      userMessage: 'Only an administrator can power a different Profile',
      context: {
        reason: 'profile-activation-not-authorized',
        profileId,
        activeProfileId,
      },
    });
  }

  private async withDisconnectIntentIfConnected<T>(
    reason: string,
    task: () => Promise<T>,
  ): Promise<T> {
    if (!this.deps.isRadioConnected()) {
      return task();
    }

    const intent = this.deps.markIntentionalDisconnect(reason);
    try {
      return await task();
    } finally {
      // RadioBridge consumes the token synchronously when a disconnect event is
      // emitted. Clearing the same token here covers stop paths that never emit.
      this.deps.clearIntentionalDisconnect(intent);
    }
  }

  private projectProfileContext(
    profile: RadioProfile,
    previousProfileId: string | null,
    wasRunning: boolean,
  ): void {
    const failures: string[] = [];
    const runProjection = (name: string, task: () => void): void => {
      try {
        task();
      } catch (error) {
        failures.push(`${name}: ${this.errorMessage(error)}`);
        logger.error(`Profile projection failed (${name})`, error);
      }
    };

    runProjection('runtime context', () => this.deps.applyProfileContext());
    runProjection('audio config', () => this.deps.reloadAudioConfig());
    runProjection('profile event', () => {
      const engineMode = this.deps.getEngineMode();
      const currentMode = structuredClone(this.deps.getCurrentMode());
      this.deps.emitProfileChanged({
        profileId: profile.id,
        profile,
        previousProfileId,
        wasRunning,
        generation: this.generation,
        engineMode,
        currentMode,
      });
    });

    if (failures.length > 0) {
      throw new RadioError({
        code: RadioErrorCode.RESOURCE_UNAVAILABLE,
        message: `Profile ${profile.id} was activated, but runtime projection failed: ${failures.join('; ')}`,
        userMessage: 'The Profile changed, but its runtime configuration could not be fully applied',
        suggestions: ['Retry Profile activation after checking the radio and audio configuration'],
        context: {
          profileId: profile.id,
          previousProfileId,
          profileActivated: true,
          generation: this.generation,
          projectionFailures: failures,
        },
      });
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
