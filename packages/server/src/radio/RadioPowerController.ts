import type {
  HamlibConfig,
  RadioPowerRequest,
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
  private powerLock: Promise<void> | null = null;

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

  async handleRequest(request: RadioPowerRequest): Promise<void> {
    const profile = this.resolveProfile(request.profileId);
    await this.runExclusive(async () => {
      if (request.state === 'on') {
        await this.doPowerOn(profile.id, profile.radio, request.autoEngine ?? true);
      } else {
        // off / standby / operate 都视为关机：用户意图都是"让电台从工作状态离开"，
        // 差异仅在发送的 CI-V 代码（不同型号对这些代码响应不同）
        await this.doPowerDown(profile.id, request.state);
      }
    });
  }

  async getSupportInfo(profileId: string): Promise<RadioPowerSupportInfo> {
    const profile = this.resolveProfile(profileId);
    const rigInfo = await this.resolveRigInfo(profile.radio);
    const decision = decidePowerSupport(profile.radio, rigInfo);
    const supportedStates = decision.canPowerOff
      ? (['operate', 'standby', 'off'] as Array<'operate' | 'standby' | 'off'>)
      : [];
    return {
      profileId: profile.id,
      canPowerOn: decision.canPowerOn,
      canPowerOff: decision.canPowerOff,
      supportedStates,
      reason: decision.reason,
      rigInfo,
    };
  }

  // ─── power transitions ────────────────────────────────

  private async doPowerOn(profileId: string, _config: HamlibConfig, autoEngine: boolean): Promise<void> {
    this.broadcast({ profileId, state: 'waking', stage: 'sending_command' });
    const lifecycle = this.deps.getEngineLifecycle();
    const { radioManager } = this.deps;
    const configManager = ConfigManager.getInstance();

    if (!autoEngine) {
      logger.warn('autoEngine=false is not yet supported; defaulting to auto-start');
    }

    try {
      // 若点击的是非激活 Profile，先切换激活态——wake flow 会读 active profile，
      // 不切换就会错误地唤醒之前激活的那台电台。此处不启动引擎，wake 会接管。
      const currentActiveId = configManager.getActiveProfileId();
      if (currentActiveId !== profileId) {
        logger.info(`Switching active profile for wake: ${currentActiveId ?? '(none)'} -> ${profileId}`);
        if (lifecycle.getIsRunning()) {
          radioManager.markIntentionalDisconnect('profile switch for wake');
          await lifecycle.stop().catch(() => undefined);
        }
        if (radioManager.isConnected()) {
          radioManager.markIntentionalDisconnect('profile switch for wake');
          await radioManager.disconnect('profile switch for wake').catch(() => undefined);
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

      this.broadcast({ profileId, state: 'waking', stage: 'waiting_ready' });
      await lifecycle.wakeAndWaitForRunning(60_000);
      this.broadcast({ profileId, state: 'awake', stage: 'starting_engine' });
      logger.info(`Power-on complete for profile ${profileId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Power-on failed:', err);
      this.broadcast({
        profileId,
        state: 'failed',
        stage: 'idle',
        errorKey: 'radio:power.error.timeout',
        errorDetail: err.message,
      });
      throw err;
    }
  }

  /**
   * 统一的关机流程：off / standby / operate 三个目标都走相同的编排路径，
   * 差异仅在于发给电台的 CI-V 代码（由 connection.setPowerState 映射）。
   *
   * 顺序很关键：
   *   1. 先发 CI-V 命令（此时连接仍在，engine 未停，能真正送达电台）
   *   2. 命令送达后立即 markIntentionalDisconnect，抑制随后电台开始断 CAT
   *      期间 frequency monitoring / health check 的错误触发重连循环
   *   3. stop engine（radio 资源 stop 会顺带 disconnect）
   *   4. 兜底 disconnect（以防 engine 未在运行态）
   */
  private async doPowerDown(
    profileId: string,
    target: 'off' | 'standby' | 'operate'
  ): Promise<void> {
    const isStandby = target === 'standby';
    const broadcastState = isStandby ? 'entering_standby' : 'shutting_down';
    this.broadcast({ profileId, state: broadcastState, stage: 'sending_command' });

    const lifecycle = this.deps.getEngineLifecycle();
    const { radioManager } = this.deps;

    try {
      // 1. 先发送 CI-V 电源命令（off=0x18 0x00 / standby=0x18 0x02 / operate=0x18 0x04）
      //    此时连接仍然活跃，命令能真正送达电台
      const connection = radioManager.getActiveConnection();
      if (connection?.setPowerState) {
        try {
          await connection.setPowerState(target);
        } catch (error) {
          logger.warn(`setPowerState(${target}) returned error (continuing):`, error);
        }
      } else {
        logger.warn('No active connection available for power command');
      }

      // 2. 立刻标记为主动断线，抑制电台关机过程中可能出现的 Command rejected
      //    等错误触发 HEALTH_CHECK_FAILED → reconnect 循环
      radioManager.markIntentionalDisconnect(`power ${target}`);

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
      logger.info(`Power-down (${target}) complete for profile ${profileId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Power-down (${target}) failed:`, err);
      this.broadcast({
        profileId,
        state: 'failed',
        stage: 'idle',
        errorKey: 'radio:power.error.timeout',
        errorDetail: err.message,
      });
      throw err;
    }
  }

  // ─── helpers ───────────────────────────────────────────

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

  private async runExclusive(task: () => Promise<void>): Promise<void> {
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
        await task();
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
