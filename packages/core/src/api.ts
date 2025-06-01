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

  // ========== 模式管理API ==========

  /**
   * 获取所有可用模式
   */
  async getAvailableModes(apiBase = '/api'): Promise<{ success: boolean; data: ModeDescriptor[] }> {
    const res = await fetch(`${apiBase}/mode`);
    if (!res.ok) {
      throw new Error(`获取可用模式失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 获取当前模式
   */
  async getCurrentMode(apiBase = '/api'): Promise<{ success: boolean; data: ModeDescriptor }> {
    const res = await fetch(`${apiBase}/mode/current`);
    if (!res.ok) {
      throw new Error(`获取当前模式失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  },

  /**
   * 切换模式
   */
  async switchMode(
    mode: ModeDescriptor, 
    apiBase = '/api'
  ): Promise<{ success: boolean; message: string; data: ModeDescriptor }> {
    const res = await fetch(`${apiBase}/mode/switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mode),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `切换模式失败: ${res.status} ${res.statusText}`);
    }
    
    return await res.json();
  },
}

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
  getAvailableModes,
  getCurrentMode,
  switchMode
} = api; 