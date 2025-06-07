/**
 * 操作员偏好设置管理
 * 用于在localStorage中保存客户端对操作员的启用状态
 */

const STORAGE_KEY = 'tx5dr_operator_preferences';

export interface OperatorPreferences {
  enabledOperatorIds: string[];
  lastUpdated: number;
}

/**
 * 获取操作员偏好设置
 */
export function getOperatorPreferences(): OperatorPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        enabledOperatorIds: parsed.enabledOperatorIds || [],
        lastUpdated: parsed.lastUpdated || Date.now()
      };
    }
  } catch (error) {
    console.warn('❌ 读取操作员偏好设置失败:', error);
  }
  
  // 返回默认值：启用所有操作员
  return {
    enabledOperatorIds: [],
    lastUpdated: Date.now()
  };
}

/**
 * 保存操作员偏好设置
 */
export function setOperatorPreferences(preferences: OperatorPreferences): void {
  try {
    const toStore = {
      ...preferences,
      lastUpdated: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    console.log('💾 操作员偏好设置已保存:', toStore);
  } catch (error) {
    console.error('❌ 保存操作员偏好设置失败:', error);
  }
}

/**
 * 检查操作员是否被启用
 */
export function isOperatorEnabled(operatorId: string): boolean {
  // 如果从未设置过偏好，默认启用所有操作员
  if (!hasOperatorPreferences()) {
    return true;
  }
  
  // 如果有偏好设置，严格按照保存的列表判断（空列表=全部禁用）
  const preferences = getOperatorPreferences();
  return preferences.enabledOperatorIds.includes(operatorId);
}

/**
 * 设置操作员启用状态
 */
export function setOperatorEnabled(operatorId: string, enabled: boolean): void {
  const preferences = getOperatorPreferences();
  const currentIds = new Set(preferences.enabledOperatorIds);
  
  if (enabled) {
    currentIds.add(operatorId);
  } else {
    currentIds.delete(operatorId);
  }
  
  setOperatorPreferences({
    enabledOperatorIds: Array.from(currentIds),
    lastUpdated: Date.now()
  });
}

/**
 * 设置所有操作员的启用状态
 */
export function setAllOperatorsEnabled(operatorIds: string[], enabled: boolean): void {
  if (enabled) {
    // 启用所有操作员
    setOperatorPreferences({
      enabledOperatorIds: [...operatorIds],
      lastUpdated: Date.now()
    });
  } else {
    // 禁用所有操作员
    setOperatorPreferences({
      enabledOperatorIds: [],
      lastUpdated: Date.now()
    });
  }
}

/**
 * 获取启用的操作员ID列表
 */
export function getEnabledOperatorIds(): string[] {
  const preferences = getOperatorPreferences();
  return preferences.enabledOperatorIds;
}

/**
 * 检查是否有保存的偏好设置
 */
export function hasOperatorPreferences(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null;
  } catch (error) {
    return false;
  }
}

/**
 * 获取握手消息的操作员配置
 * 区分新客户端（返回null表示启用所有）和已配置客户端（返回具体列表）
 */
export function getHandshakeOperatorIds(): string[] | null {
  if (!hasOperatorPreferences()) {
    // 新客户端，没有任何偏好设置，返回null表示默认启用所有操作员
    console.log('🆕 [OperatorPreferences] 新客户端，发送null（启用所有操作员）');
    return null;
  }
  
  // 已有偏好设置的客户端，返回具体的启用列表
  const enabledIds = getEnabledOperatorIds();
  console.log('🔧 [OperatorPreferences] 已有偏好设置，启用操作员:', enabledIds);
  return enabledIds;
} 