import type { 
  HelloResponse,
  AudioDevicesResponse,
  AudioDeviceSettings,
  AudioDeviceSettingsResponse,
  FT8ConfigUpdate,
  ServerConfigUpdate,
  ModeDescriptor
} from '@tx5dr/contracts';

// ========== API 对象 ==========

export const api = {
  // ========== 基础API ==========
  
  /**
   * 获取Hello消息
   */
  async getHello(apiBase = '/api'): Promise<HelloResponse> {
    const res = await fetch(`${apiBase}/hello`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return (await res.json()) as HelloResponse;
  },

  // ========== 音频设备API ==========

  /**
   * 获取所有音频设备列表
   */
  async getAudioDevices(apiBase = '/api'): Promise<AudioDevicesResponse> {
    const res = await fetch(`${apiBase}/audio/devices`);
    if (!res.ok) {
      throw new Error(`获取音频设备失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AudioDevicesResponse;
  },

  /**
   * 获取当前音频设备设置
   */
  async getAudioSettings(apiBase = '/api'): Promise<AudioDeviceSettingsResponse> {
    const res = await fetch(`${apiBase}/audio/settings`);
    if (!res.ok) {
      throw new Error(`获取音频设置失败: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AudioDeviceSettingsResponse;
  },

  /**
   * 更新音频设备设置
   */
  async updateAudioSettings(
    settings: AudioDeviceSettings, 
    apiBase = '/api'
  ): Promise<AudioDeviceSettingsResponse> {
    const res = await fetch(`${apiBase}/audio/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新音频设置失败: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as AudioDeviceSettingsResponse;
  },

  /**
   * 重置音频设备设置
   */
  async resetAudioSettings(apiBase = '/api'): Promise<AudioDeviceSettingsResponse> {
    const res = await fetch(`${apiBase}/audio/settings/reset`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      throw new Error(`重置音频设置失败: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as AudioDeviceSettingsResponse;
  },

  // ========== 配置管理API ==========

  /**
   * 获取完整配置
   */
  async getConfig(apiBase = '/api'): Promise<{ success: boolean; data: any }> {
    const res = await fetch(`${apiBase}/config`);
    if (!res.ok) {
      throw new Error(`获取配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 获取FT8配置
   */
  async getFT8Config(apiBase = '/api'): Promise<{ success: boolean; data: any }> {
    const res = await fetch(`${apiBase}/config/ft8`);
    if (!res.ok) {
      throw new Error(`获取FT8配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 更新FT8配置
   */
  async updateFT8Config(
    config: FT8ConfigUpdate, 
    apiBase = '/api'
  ): Promise<{ success: boolean; message: string; data: any }> {
    const res = await fetch(`${apiBase}/config/ft8`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新FT8配置失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 获取服务器配置
   */
  async getServerConfig(apiBase = '/api'): Promise<{ success: boolean; data: any }> {
    const res = await fetch(`${apiBase}/config/server`);
    if (!res.ok) {
      throw new Error(`获取服务器配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 更新服务器配置
   */
  async updateServerConfig(
    config: ServerConfigUpdate, 
    apiBase = '/api'
  ): Promise<{ success: boolean; message: string; data: any }> {
    const res = await fetch(`${apiBase}/config/server`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `更新服务器配置失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 验证配置
   */
  async validateConfig(apiBase = '/api'): Promise<{ success: boolean; data: { isValid: boolean; errors: string[] } }> {
    const res = await fetch(`${apiBase}/config/validate`);
    if (!res.ok) {
      throw new Error(`验证配置失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 重置配置
   */
  async resetConfig(apiBase = '/api'): Promise<{ success: boolean; message: string; data: any }> {
    const res = await fetch(`${apiBase}/config/reset`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      throw new Error(`重置配置失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },

  /**
   * 获取配置文件路径
   */
  async getConfigPath(apiBase = '/api'): Promise<{ success: boolean; data: { path: string } }> {
    const res = await fetch(`${apiBase}/config/path`);
    if (!res.ok) {
      throw new Error(`获取配置文件路径失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  // ========== 时钟和模式API ==========

  /**
   * 获取可用的模式列表
   */
  async getModes(apiBase = '/api'): Promise<{ modes: ModeDescriptor[]; default: string }> {
    const res = await fetch(`${apiBase}/modes`);
    if (!res.ok) {
      throw new Error(`获取模式列表失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 获取时钟状态
   */
  async getClockStatus(apiBase = '/api'): Promise<{
    isRunning: boolean;
    currentMode: ModeDescriptor;
    currentTime: number;
    nextSlotIn: number;
  }> {
    const res = await fetch(`${apiBase}/clock/status`);
    if (!res.ok) {
      throw new Error(`获取时钟状态失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 设置时钟模式
   */
  async setClockMode(mode: string, apiBase = '/api'): Promise<void> {
    const res = await fetch(`${apiBase}/clock/mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ mode })
    });
    
    if (!res.ok) {
      throw new Error(`设置时钟模式失败: ${res.status} ${res.statusText}`);
    }
  },

  /**
   * 控制时钟启停
   */
  async controlClock(action: 'start' | 'stop', apiBase = '/api'): Promise<void> {
    const res = await fetch(`${apiBase}/clock/control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action })
    });
    
    if (!res.ok) {
      throw new Error(`控制时钟失败: ${res.status} ${res.statusText}`);
    }
  }
};

// 为了向后兼容，也导出单独的函数
export const {
  getHello,
  getAudioDevices,
  getAudioSettings,
  updateAudioSettings,
  resetAudioSettings,
  getConfig,
  getFT8Config,
  updateFT8Config,
  getServerConfig,
  updateServerConfig,
  validateConfig,
  resetConfig,
  getConfigPath,
  getModes,
  getClockStatus,
  setClockMode,
  controlClock
} = api; 