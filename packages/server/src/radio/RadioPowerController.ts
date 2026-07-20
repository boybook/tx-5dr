import type {
  HamlibConfig,
  RadioPowerRequest,
  RadioPowerState,
  RadioPowerStateEvent,
  RadioPowerSupportInfo,
  RadioPowerTarget,
  RadioProfile,
} from '@tx5dr/contracts';
import { decidePowerSupport } from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { PhysicalRadioManager } from './PhysicalRadioManager.js';
import type { EngineLifecycle } from '../subsystems/EngineLifecycle.js';
import { isRecoverableOptionalRadioError } from './optionalRadioError.js';

const logger = createLogger('RadioPowerController');

export interface RadioPowerControllerEvents {
  powerState: (event: RadioPowerStateEvent) => void;
}

export interface RadioPowerControllerDeps {
  radioManager: PhysicalRadioManager;
  getEngineLifecycle: () => EngineLifecycle;
  runProfilePowerOperation: <T>(
    profileId: string,
    options: {
      refreshContext: boolean;
      allowProfileActivation: boolean;
    },
    task: (profile: RadioProfile) => Promise<T>,
  ) => Promise<T>;
}

export interface RadioPowerRequestContext {
  allowProfileActivation?: boolean;
}

/**
 * Profile-level power management.
 *
 * Separates radio power transitions from the capability system because
 * power changes affect connection reachability itself (wake requires a
 * control-only link, standby/off tear down the connection).
 */
export class RadioPowerController extends EventEmitter<RadioPowerControllerEvents> {
  private static instance: RadioPowerController | null = null;

  private readonly deps: RadioPowerControllerDeps;
  private powerLock: Promise<unknown> | null = null;

  private constructor(deps: RadioPowerControllerDeps) {
    super();
    this.deps = deps;
  }

  static create(deps: RadioPowerControllerDeps): RadioPowerController {
    if (!RadioPowerController.instance) {
      RadioPowerController.instance = new RadioPowerController(deps);
    }
    return RadioPowerController.instance;
  }

  static tryGetInstance(): RadioPowerController | null {
    return RadioPowerController.instance;
  }

  async handleRequest(
    request: RadioPowerRequest,
    context: RadioPowerRequestContext = {},
  ): Promise<RadioPowerState> {
    return this.runExclusive(async () => {
      return this.deps.runProfilePowerOperation(
        request.profileId,
        {
          refreshContext: request.state === 'on',
          allowProfileActivation: context.allowProfileActivation === true,
        },
        (profile) => this.deps.radioManager.withPowerOperation(`power ${request.state}`, async () => {
          if (request.state === 'on') {
            return this.doPowerOn(profile.id, profile.radio, request.autoEngine ?? true);
          }
          if (request.state === 'operate') {
            return this.doOperate(profile.id, profile.radio);
          }
          return this.doPowerDown(profile.id, profile.radio, request.state);
        }),
      );
    });
  }

  async getSupportInfo(profileId: string): Promise<RadioPowerSupportInfo> {
    const profile = this.resolveProfile(profileId);
    const rigInfo = await this.resolveRigInfo(profile.radio);
    const decision = decidePowerSupport(profile.radio, rigInfo);
    return {
      profileId: profile.id,
      canPowerOn: decision.canPowerOn,
      canPowerOff: decision.canPowerOff,
      supportedStates: decision.supportedStates,
      reason: decision.reason,
      rigInfo,
    };
  }

  // ─── power transitions ────────────────────────────────

  private async doPowerOn(profileId: string, config: HamlibConfig, autoEngine: boolean): Promise<RadioPowerState> {
    this.broadcast({ profileId, state: 'waking', stage: 'sending_command' });
    const lifecycle = this.deps.getEngineLifecycle();
    const { radioManager } = this.deps;

    try {
      this.broadcast({ profileId, state: 'waking', stage: 'waiting_ready' });
      await radioManager.wakeAndConnect(config);

      if (autoEngine) {
        this.broadcast({ profileId, state: 'awake', stage: 'starting_engine' });
        await lifecycle.startAndWaitForRunning(60_000);
      }

      this.broadcast({ profileId, state: 'awake', stage: 'idle' });
      logger.info(`Physical power-on complete for profile ${profileId}`);
      return 'awake';
    } catch (error) {
      this.broadcastFailure(profileId, error, 'Power-on failed');
      throw error;
    }
  }

  private async doOperate(profileId: string, config: HamlibConfig): Promise<RadioPowerState> {
    this.broadcast({ profileId, state: 'awake', stage: 'sending_command' });

    try {
      await this.ensureCatLinkForPowerCommand(profileId, config, 'operate');
      await this.sendConnectedPowerCommand('operate');
      this.broadcast({ profileId, state: 'awake', stage: 'idle' });
      logger.info(`Physical power target operate complete for profile ${profileId}`);
      return 'awake';
    } catch (error) {
      this.broadcastFailure(profileId, error, 'Power operate failed');
      throw error;
    }
  }

  /**
   * 物理 off / standby 流程。
   *
   * 顺序很关键：
   *   1. 先发物理电源命令（此时 CAT 连接仍在）
   *   2. 只有命令成功后，才停止 TX-5DR 引擎并断开连接
   *   3. 若命令 unsupported/invalid，保持当前连接和引擎状态
   */
  private async doPowerDown(
    profileId: string,
    config: HamlibConfig,
    target: 'off' | 'standby'
  ): Promise<RadioPowerState> {
    const isStandby = target === 'standby';
    const broadcastState = isStandby ? 'entering_standby' : 'shutting_down';
    this.broadcast({ profileId, state: broadcastState, stage: 'sending_command' });

    const lifecycle = this.deps.getEngineLifecycle();
    const { radioManager } = this.deps;

    try {
      await this.ensureCatLinkForPowerCommand(profileId, config, target);

      // Only a live CAT session can produce the disconnect event this token scopes.
      const disconnectIntent = radioManager.isConnected()
        ? radioManager.markIntentionalDisconnect(`power ${target}`)
        : null;
      try {
        // A rejected command is never treated as success. Connection/session
        // errors can also be raised before the hardware write is submitted.
        await this.sendConnectedPowerCommand(target);

        if (!radioManager.isConnected()) {
          logger.info(`CAT link already disconnected after power ${target}; proceeding with resource teardown`);
        }

        // 让命令真正送达电台并让电台开始处理
        await new Promise((resolve) => setTimeout(resolve, 300));

        const cleanupFailures: string[] = [];

        // 3. 停引擎：audio/clock/slot 按逆序停止；radio 资源 stop 内部会
        //    调用 radioManager.disconnect('Engine stopped') 触发 disconnected 事件
        this.broadcast({ profileId, state: broadcastState, stage: 'stopping_engine' });
        if (lifecycle.getIsRunning()) {
          try {
            await lifecycle.stop();
          } catch (error) {
            cleanupFailures.push(`engine stop: ${this.errorMessage(error)}`);
          }
        }

        // 4. 即使引擎清理失败也继续尝试关闭 CAT，最后统一报告失败。
        this.broadcast({ profileId, state: broadcastState, stage: 'disconnecting' });
        if (radioManager.isConnected()) {
          try {
            await radioManager.disconnect(`power ${target}`);
          } catch (error) {
            cleanupFailures.push(`radio disconnect: ${this.errorMessage(error)}`);
          }
        }

        if (cleanupFailures.length > 0) {
          throw new RadioError({
            code: RadioErrorCode.RESOURCE_CLEANUP_FAILED,
            message: `Power ${target} command succeeded, but local cleanup failed: ${cleanupFailures.join('; ')}`,
            userMessage: 'The radio power command succeeded, but TX-5DR could not finish local cleanup',
            suggestions: ['Retry disconnecting the radio or restart the TX-5DR engine'],
            context: { profileId, target, cleanupFailures, powerCommandSucceeded: true },
          });
        }

        this.broadcast({ profileId, state: 'off', stage: 'idle' });
        logger.info(`Physical power target ${target} complete for profile ${profileId}`);
        return 'off';
      } finally {
        // If no disconnect event consumed this exact intent, do not let it leak
        // into a later, unrelated radio session.
        if (disconnectIntent) {
          radioManager.clearIntentionalDisconnect(disconnectIntent);
        }
      }
    } catch (error) {
      this.broadcastFailure(profileId, error, `Power ${target} failed`);
      throw error;
    }
  }

  // ─── helpers ───────────────────────────────────────────

  private async ensureCatLinkForPowerCommand(
    _profileId: string,
    config: HamlibConfig,
    target: 'off' | 'standby' | 'operate'
  ): Promise<void> {
    if (this.deps.radioManager.isConnected()) {
      return;
    }

    logger.info(`Opening CAT link for physical power ${target}; engine may remain idle`);
    await this.deps.radioManager.applyConfig(config);
  }

  private async sendConnectedPowerCommand(target: 'off' | 'standby' | 'operate'): Promise<void> {
    const connection = this.deps.radioManager.getActiveConnection();
    if (!connection?.setPowerState) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: 'No active CAT connection available for physical power command',
        userMessage: 'Radio is not connected',
        suggestions: ['Connect to the radio before sending this power command'],
      });
    }
    await connection.setPowerState(target);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private broadcastFailure(profileId: string, error: unknown, logMessage: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(logMessage, err);
    this.broadcast({
      profileId,
      state: 'failed',
      stage: 'idle',
      errorKey: isRecoverableOptionalRadioError(error)
        ? 'radio:power.error.notSupported'
        : 'radio:power.error.timeout',
      errorDetail: err.message,
    });
  }

  private resolveProfile(profileId: string) {
    const cfg = ConfigManager.getInstance();
    const profile = cfg.getProfile(profileId);
    if (!profile) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Profile not found: ${profileId}`,
        userMessage: 'Profile not found',
        suggestions: [],
      });
    }
    return profile;
  }

  private async resolveRigInfo(
    config: HamlibConfig
  ): Promise<{ mfgName: string; modelName: string } | undefined> {
    if (config.type === 'icom-wlan') {
      return { mfgName: 'Icom', modelName: 'IC-WLAN' };
    }
    if (config.type !== 'serial' || !config.serial?.rigModel) {
      return undefined;
    }
    try {
      const rigs = await PhysicalRadioManager.listSupportedRigs();
      const match = rigs.find((r) => r.rigModel === config.serial!.rigModel);
      if (!match) return undefined;
      return { mfgName: match.mfgName, modelName: match.modelName };
    } catch (error) {
      logger.warn('Failed to resolve rig info:', error);
      return undefined;
    }
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.powerLock) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: 'Another power operation is already in progress',
        userMessage: 'Another power operation is already in progress',
        suggestions: ['Wait for it to complete'],
      });
    }
    const pending = (async () => {
      try {
        return await task();
      } finally {
        this.powerLock = null;
      }
    })();
    this.powerLock = pending;
    return pending;
  }

  private broadcast(event: RadioPowerStateEvent): void {
    this.emit('powerState', event);
  }
}

export type { RadioPowerTarget };
