import type {
  HamlibConfig,
  RadioPowerRequest,
  RadioPowerState,
  RadioPowerStateEvent,
  RadioPowerSupportInfo,
  RadioPowerTarget,
} from '@tx5dr/contracts';
import { decidePowerSupport } from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { PhysicalRadioManager } from './PhysicalRadioManager.js';
import type { EngineLifecycle } from '../subsystems/EngineLifecycle.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { isRecoverableOptionalRadioError } from './optionalRadioError.js';

const logger = createLogger('RadioPowerController');

export interface RadioPowerControllerEvents {
  powerState: (event: RadioPowerStateEvent) => void;
}

export interface RadioPowerControllerDeps {
  radioManager: PhysicalRadioManager;
  getEngineLifecycle: () => EngineLifecycle;
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

  async handleRequest(request: RadioPowerRequest): Promise<RadioPowerState> {
    const profile = this.resolveProfile(request.profileId);
    return this.runExclusive(async () => {
      return this.deps.radioManager.withPowerOperation(`power ${request.state}`, async () => {
        if (request.state === 'on') {
          return this.doPowerOn(profile.id, profile.radio, request.autoEngine ?? true);
        }
        if (request.state === 'operate') {
          return this.doOperate(profile.id, profile.radio);
        }
        return this.doPowerDown(profile.id, profile.radio, request.state);
      });
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
      await this.activateProfileForPowerOperation(profileId);

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

      // Mark before the command so an immediate CAT drop is projected as intentional.
      radioManager.markIntentionalDisconnect(`power ${target}`);
      try {
        await this.sendConnectedPowerCommand(target);
      } catch (error) {
        if (this.isExpectedPowerDownDisconnect(error)) {
          logger.info(`Power ${target} command observed expected CAT disconnect; continuing resource teardown`);
        } else {
          radioManager.clearIntentionalDisconnect();
          throw error;
        }
      }

      if (!radioManager.isConnected()) {
        logger.info(`CAT link already disconnected after power ${target}; proceeding with resource teardown`);
      }

      // 让命令真正送达电台并让电台开始处理
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 3. 停引擎：audio/clock/slot 按逆序停止；radio 资源 stop 内部会
      //    调用 radioManager.disconnect('Engine stopped') 触发 disconnected 事件
      this.broadcast({ profileId, state: broadcastState, stage: 'stopping_engine' });
      if (lifecycle.getIsRunning()) {
        await lifecycle.stop().catch(() => undefined);
      }

      // 4. 兜底：若 engine 原本未运行，radio 资源没机会走 stop，直接 disconnect
      this.broadcast({ profileId, state: broadcastState, stage: 'disconnecting' });
      if (radioManager.isConnected()) {
        await radioManager.disconnect(`power ${target}`).catch(() => undefined);
      }

      this.broadcast({ profileId, state: 'off', stage: 'idle' });
      logger.info(`Physical power target ${target} complete for profile ${profileId}`);
      return 'off';
    } catch (error) {
      this.broadcastFailure(profileId, error, `Power ${target} failed`);
      throw error;
    }
  }

  // ─── helpers ───────────────────────────────────────────

  private async ensureCatLinkForPowerCommand(
    profileId: string,
    config: HamlibConfig,
    target: 'off' | 'standby' | 'operate'
  ): Promise<void> {
    await this.activateProfileForPowerOperation(profileId);
    if (this.deps.radioManager.isConnected()) {
      return;
    }

    logger.info(`Opening CAT link for physical power ${target}; engine may remain idle`);
    await this.deps.radioManager.applyConfig(config);
  }

  private async activateProfileForPowerOperation(profileId: string): Promise<void> {
    const configManager = ConfigManager.getInstance();
    const lifecycle = this.deps.getEngineLifecycle();
    const { radioManager } = this.deps;
    const currentActiveId = configManager.getActiveProfileId();
    if (currentActiveId === profileId) {
      return;
    }

    logger.info(`Switching active profile for power operation: ${currentActiveId ?? '(none)'} -> ${profileId}`);
    if (lifecycle.getIsRunning()) {
      radioManager.markIntentionalDisconnect('profile switch for power operation');
      await lifecycle.stop().catch(() => undefined);
    }
    if (radioManager.isConnected()) {
      radioManager.markIntentionalDisconnect('profile switch for power operation');
      await radioManager.disconnect('profile switch for power operation').catch(() => undefined);
    }
    await configManager.setActiveProfileId(profileId);
    const profile = configManager.getProfile(profileId);
    if (profile) {
      const engine = DigitalRadioEngine.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).emit('profileChanged', {
        profileId,
        profile,
        previousProfileId: currentActiveId,
        wasRunning: false,
      });
    }
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

  private isExpectedPowerDownDisconnect(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('radio session changed')
      || message.includes('current state: disconnected')
      || message.includes('radio not connected')
      || message.includes('connection lost')
      || message.includes('disconnected');
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
