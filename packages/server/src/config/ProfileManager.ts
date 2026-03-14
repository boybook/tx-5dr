import type { RadioProfile, CreateProfileRequest, UpdateProfileRequest } from '@tx5dr/contracts';
import type { HamlibConfig, AudioDeviceSettings } from '@tx5dr/contracts';
import { ConfigManager } from './config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';

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

    // ICOM WLAN 模式下自动锁定音频
    const audioLockedToRadio = data.radio.type === 'icom-wlan';
    let audio: AudioDeviceSettings = data.audio || { sampleRate: 48000, bufferSize: 768 };

    if (audioLockedToRadio) {
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
    console.log(`✅ [ProfileManager] 创建 Profile: "${profile.name}" (id: ${profile.id})`);

    // 广播列表更新事件
    this.broadcastProfileListUpdated();

    return profile;
  }

  /**
   * 更新 Profile
   */
  async updateProfile(id: string, updates: UpdateProfileRequest): Promise<RadioProfile> {
    const configManager = ConfigManager.getInstance();

    // 如果更新了电台类型为 icom-wlan，自动锁定音频
    if (updates.radio?.type === 'icom-wlan') {
      updates.audioLockedToRadio = true;
      if (!updates.audio) {
        const existing = configManager.getProfile(id);
        updates.audio = {
          ...(existing?.audio || { sampleRate: 48000, bufferSize: 768 }),
          inputDeviceName: 'ICOM WLAN',
          outputDeviceName: 'ICOM WLAN',
        };
      } else {
        updates.audio = {
          ...updates.audio,
          inputDeviceName: 'ICOM WLAN',
          outputDeviceName: 'ICOM WLAN',
        };
      }
    }

    const profile = await configManager.updateProfile(id, updates);
    console.log(`✅ [ProfileManager] 更新 Profile: "${profile.name}" (id: ${id})`);

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
      throw new Error('无法删除当前激活的 Profile，请先切换到其他 Profile');
    }

    const profile = configManager.getProfile(id);
    await configManager.deleteProfile(id);
    console.log(`✅ [ProfileManager] 删除 Profile: "${profile?.name}" (id: ${id})`);

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
      throw new Error(`Profile ${id} 不存在`);
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
            setTimeout(() => reject(new Error('引擎停止超时')), 10_000)
          ),
        ]);
        console.log('✅ [ProfileManager] 引擎已停止');
      } catch (stopError) {
        // 停止超时或失败：记录日志但继续切换
        console.warn('⚠️ [ProfileManager] 引擎停止异常，继续切换:', stopError);
      }
    }

    // 阶段2：切换配置（原子操作）
    await configManager.setActiveProfileId(id);
    console.log(`✅ [ProfileManager] 已激活 Profile: "${profile.name}" (id: ${id})`);

    // 阶段3：广播事件通知前端
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine.emit('profileChanged' as any, {
      profileId: id,
      profile,
      previousProfileId,
      wasRunning,
    });

    // 阶段4：如果之前在运行，自动重启引擎（使用新 Profile 配置）
    if (wasRunning) {
      try {
        console.log('🚀 [ProfileManager] 之前引擎在运行，自动重启...');
        await engine.start();
        console.log('✅ [ProfileManager] 引擎已自动重启');
      } catch (startError) {
        console.error('❌ [ProfileManager] 引擎自动重启失败:', startError);
        // 启动失败不影响 Profile 切换结果，错误会通过引擎事件通知前端
      }
    }

    return {
      success: true,
      profile,
      wasRunning,
    };
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
