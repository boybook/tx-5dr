import type { RadioProfile, CreateProfileRequest, UpdateProfileRequest } from '@tx5dr/contracts';
import type { HamlibConfig, AudioDeviceSettings } from '@tx5dr/contracts';
import { ConfigManager } from './config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProfileManager');

/**
 * ProfileManager - Profile 业务管理器
 *
 * 编排 Profile 操作 + 引擎重启逻辑。
 * 所有 Profile CRUD 通过此类操作，不直接操作 ConfigManager 的 Profile 方法。
 */
export class ProfileManager {
  private static instance: ProfileManager;

  private constructor() {}

  static getInstance(): ProfileManager {
    if (!ProfileManager.instance) {
      ProfileManager.instance = new ProfileManager();
    }
    return ProfileManager.instance;
  }

  /**
   * 创建 Profile
   */
  async createProfile(data: CreateProfileRequest): Promise<RadioProfile> {
    const configManager = ConfigManager.getInstance();
    const now = Date.now();

    // ICOM WLAN 模式下，仅在用户未指定音频设备时默认使用 ICOM WLAN 虚拟设备
    const audioLockedToRadio = data.radio.type === 'icom-wlan';
    let audio: AudioDeviceSettings = data.audio || { sampleRate: 48000, bufferSize: 768 };

    if (audioLockedToRadio && !audio.inputDeviceName && !audio.outputDeviceName) {
      audio = {
        ...audio,
        inputDeviceName: 'ICOM WLAN',
        outputDeviceName: 'ICOM WLAN',
      };
    }

    const profile: RadioProfile = {
      id: `profile-${now}-${Math.random().toString(36).substr(2, 9)}`,
      name: data.name,
      radio: data.radio,
      audio,
      audioLockedToRadio,
      createdAt: now,
      updatedAt: now,
      description: data.description,
    };

    await configManager.addProfile(profile);
    logger.info(`Profile created: "${profile.name}" (id: ${profile.id})`);

    // 广播列表更新事件
    this.broadcastProfileListUpdated();

    return profile;
  }

  /**
   * 更新 Profile
   */
  async updateProfile(id: string, updates: UpdateProfileRequest): Promise<RadioProfile> {
    const configManager = ConfigManager.getInstance();

    // 如果更新了电台类型为 icom-wlan，标记锁定但不强制覆盖用户的音频设备选择
    if (updates.radio?.type === 'icom-wlan') {
      updates.audioLockedToRadio = true;
      // 仅在未提供音频配置时默认设置 ICOM WLAN 虚拟设备
      if (!updates.audio) {
        const existing = configManager.getProfile(id);
        if (!existing?.audio?.inputDeviceName && !existing?.audio?.outputDeviceName) {
          updates.audio = {
            ...(existing?.audio || { sampleRate: 48000, bufferSize: 768 }),
            inputDeviceName: 'ICOM WLAN',
            outputDeviceName: 'ICOM WLAN',
          };
        }
      }
    }

    const profile = await configManager.updateProfile(id, updates);
    logger.info(`Profile updated: "${profile.name}" (id: ${id})`);

    // 广播列表更新事件
    this.broadcastProfileListUpdated();

    return profile;
  }

  /**
   * 删除 Profile
   */
  async deleteProfile(id: string): Promise<void> {
    const configManager = ConfigManager.getInstance();

    // 禁止删除当前激活的 Profile
    if (configManager.getActiveProfileId() === id) {
      throw new Error('Cannot delete active Profile, please switch to another Profile first');
    }

    const profile = configManager.getProfile(id);
    await configManager.deleteProfile(id);
    logger.info(`Profile deleted: "${profile?.name}" (id: ${id})`);

    // 广播列表更新事件
    this.broadcastProfileListUpdated();
  }

  /**
   * 激活 Profile（核心流程）
   *
   * 1. 安全停止引擎（如果运行中）
   * 2. 切换配置（原子操作）
   * 3. 广播事件通知前端
   * 4. 如果之前在运行，自动重启引擎（使用新 Profile 配置）
   */
  async activateProfile(id: string): Promise<{ success: boolean; profile: RadioProfile; wasRunning: boolean }> {
    const configManager = ConfigManager.getInstance();
    const profile = configManager.getProfile(id);
    if (!profile) {
      throw new Error(`Profile ${id} does not exist`);
    }

    const engine = DigitalRadioEngine.getInstance();
    const wasRunning = engine.getStatus().isRunning;
    const previousProfileId = configManager.getActiveProfileId();

    // 阶段1：安全停止引擎
    if (wasRunning) {
      try {
        await Promise.race([
          engine.stop(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Engine stop timeout')), 10_000)
          ),
        ]);
        logger.info('Engine stopped');
      } catch (stopError) {
        // 停止超时或失败：记录日志但继续切换
        logger.warn('Engine stop error, proceeding with profile switch:', stopError);
      }
    }

    // 阶段2：切换配置（原子操作）
    await configManager.setActiveProfileId(id);
    logger.info(`Profile activated: "${profile.name}" (id: ${id})`);

    // 阶段3：广播事件通知前端
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.emit('profileChanged' as any, {
      profileId: id,
      profile,
      previousProfileId,
      wasRunning,
    });

    // 阶段4：始终启动引擎（使用新 Profile 配置）
    try {
      logger.info('Starting engine with new profile config...');
      await engine.start();
      logger.info('Engine started');
    } catch (startError) {
      logger.error('Engine start failed:', startError);
      // 启动失败不影响 Profile 切换结果，错误会通过引擎事件通知前端
    }

    return {
      success: true,
      profile,
      wasRunning,
    };
  }

  /**
   * 重排 Profile 顺序
   */
  async reorderProfiles(orderedIds: string[]): Promise<void> {
    const configManager = ConfigManager.getInstance();
    await configManager.reorderProfiles(orderedIds);
    logger.info('Profile order updated');
    this.broadcastProfileListUpdated();
  }

  /**
   * 获取指定 Profile
   */
  getProfile(id: string): RadioProfile | null {
    return ConfigManager.getInstance().getProfile(id);
  }

  /**
   * 获取所有 Profile
   */
  getAllProfiles(): RadioProfile[] {
    return ConfigManager.getInstance().getProfiles();
  }

  /**
   * 获取当前激活的 Profile
   */
  getActiveProfile(): RadioProfile | null {
    return ConfigManager.getInstance().getActiveProfile();
  }

  /**
   * 广播 Profile 列表更新事件
   */
  private broadcastProfileListUpdated(): void {
    try {
      const engine = DigitalRadioEngine.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine.emit('profileListUpdated' as any, {
        profiles: this.getAllProfiles(),
        activeProfileId: ConfigManager.getInstance().getActiveProfileId(),
      });
    } catch {
      // 引擎可能还未初始化，忽略
    }
  }
}
