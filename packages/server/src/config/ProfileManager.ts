import type {
  ActivateProfileResponse,
  RadioProfile,
  CreateProfileRequest,
  UpdateProfileRequest,
} from '@tx5dr/contracts';
import type { AudioDeviceSettings } from '@tx5dr/contracts';
import { ConfigManager, normalizeAudioDeviceSettings } from './config-manager.js';
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
    return this.runProfileMutation(async () => {
      const configManager = ConfigManager.getInstance();
      const now = Date.now();

      // Radio-audio modes default to their virtual audio device when the user has not specified one.
      const audioLockedToRadio = data.radio.type === 'icom-wlan' || data.radio.type === 'tci';
      const radioAudioDeviceName = data.radio.type === 'tci' ? 'TCI Audio' : 'ICOM WLAN';
      let audio: AudioDeviceSettings = normalizeAudioDeviceSettings(data.audio || { inputSampleRate: 48000, outputSampleRate: 48000, inputBufferSize: 1024, outputBufferSize: 1024 });

      if (audioLockedToRadio && !audio.inputDeviceName && !audio.outputDeviceName) {
        audio = {
          ...audio,
          inputDeviceName: radioAudioDeviceName,
          outputDeviceName: radioAudioDeviceName,
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
    });
  }

  /**
   * 更新 Profile
   */
  async updateProfile(id: string, updates: UpdateProfileRequest): Promise<RadioProfile> {
    return this.runProfileMutation(async () => {
      const configManager = ConfigManager.getInstance();
      const existingProfile = configManager.getProfile(id);

      // 如果更新了电台类型为 radio-audio 模式，标记锁定但不强制覆盖用户的音频设备选择
      if (updates.radio?.type === 'icom-wlan' || updates.radio?.type === 'tci') {
        updates.audioLockedToRadio = true;
        const radioAudioDeviceName = updates.radio.type === 'tci' ? 'TCI Audio' : 'ICOM WLAN';
        // 仅在未提供音频配置时默认设置对应虚拟设备
        if (!updates.audio) {
          if (!existingProfile?.audio?.inputDeviceName && !existingProfile?.audio?.outputDeviceName) {
            updates.audio = {
              ...normalizeAudioDeviceSettings(existingProfile?.audio),
              inputDeviceName: radioAudioDeviceName,
              outputDeviceName: radioAudioDeviceName,
            };
          }
        }
      }

      if (updates.audio) {
        const audioUpdates = { ...updates.audio };
        if (Object.prototype.hasOwnProperty.call(audioUpdates, 'inputDeviceName')
          && audioUpdates.inputDeviceName !== existingProfile?.audio?.inputDeviceName
          && !Object.prototype.hasOwnProperty.call(audioUpdates, 'inputRouteKey')) {
          audioUpdates.inputRouteKey = undefined;
        }
        if (Object.prototype.hasOwnProperty.call(audioUpdates, 'outputDeviceName')
          && audioUpdates.outputDeviceName !== existingProfile?.audio?.outputDeviceName
          && !Object.prototype.hasOwnProperty.call(audioUpdates, 'outputRouteKey')) {
          audioUpdates.outputRouteKey = undefined;
        }
        updates.audio = normalizeAudioDeviceSettings({ ...existingProfile?.audio, ...audioUpdates });
      }

      const profile = await configManager.updateProfile(id, updates);
      logger.info(`Profile updated: "${profile.name}" (id: ${id}); changes are deferred until Profile activation/reconnect`);

      // 广播列表更新事件
      this.broadcastProfileListUpdated();

      return profile;
    });
  }

  /**
   * 更新当前激活 Profile 的音频配置。
   *
   * 运行时自动修正、音频设置页和 radio 联动逻辑都应走这里，而不是直接调用
   * ConfigManager.updateAudioConfig()，确保持久化后统一刷新前端 Profile store。
   */
  async updateActiveProfileAudioConfig(audioConfig: Partial<AudioDeviceSettings>): Promise<void> {
    await this.runProfileMutation(async () => {
      const configManager = ConfigManager.getInstance();
      await configManager.updateAudioConfig(audioConfig);
      logger.info('Active Profile audio config updated');
      this.broadcastProfileListUpdated();
    });
  }

  /**
   * 删除 Profile
   */
  async deleteProfile(id: string): Promise<void> {
    await this.runProfileMutation(async () => {
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
    });
  }

  /**
   * 激活 Profile（核心流程）
   *
   * 1. 安全停止引擎（如果运行中）
   * 2. 切换配置（原子操作）
   * 3. 广播事件通知前端
   * 4. 如果之前在运行，自动重启引擎（使用新 Profile 配置）
   */
  async activateProfile(id: string): Promise<ActivateProfileResponse> {
    const result = await DigitalRadioEngine.getInstance()
      .getProfileActivationCoordinator()
      .activate(id, { restartEngine: true });
    logger.info(`Profile activated: "${result.profile.name}" (id: ${id})`);

    return {
      success: result.engineRunning && !result.error,
      profile: result.profile,
      wasRunning: result.wasRunning,
      engineRunning: result.engineRunning,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  /**
   * 重排 Profile 顺序
   */
  async reorderProfiles(orderedIds: string[]): Promise<void> {
    await this.runProfileMutation(async () => {
      const configManager = ConfigManager.getInstance();
      await configManager.reorderProfiles(orderedIds);
      logger.info('Profile order updated');
      this.broadcastProfileListUpdated();
    });
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

  private runProfileMutation<T>(task: () => Promise<T>): Promise<T> {
    return DigitalRadioEngine.getInstance()
      .getProfileActivationCoordinator()
      .runExclusive(task);
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
