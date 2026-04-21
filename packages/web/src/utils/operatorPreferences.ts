/**
 * 操作员偏好设置管理
 * 用于在localStorage中保存客户端对操作员的隐藏状态（黑名单模式）
 * 未在黑名单中的操作员默认显示
 */

import { createLogger } from './logger';

const logger = createLogger('OperatorPrefs');

const STORAGE_KEY = 'tx5dr_operator_preferences';

export interface OperatorPreferences {
  hiddenOperatorIds: string[];
  selectedOperatorId: string | null;
  lastUpdated: number;
}

/**
 * 获取操作员偏好设置
 * 包含旧格式（enabledOperatorIds）的自动迁移
 */
export function getOperatorPreferences(): OperatorPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);

      // 旧格式迁移：检测到 enabledOperatorIds 但没有 hiddenOperatorIds
      if (parsed.enabledOperatorIds && !parsed.hiddenOperatorIds) {
        logger.info('Migrating from whitelist to blacklist format, clearing old preferences');
        localStorage.removeItem(STORAGE_KEY);
        return {
          hiddenOperatorIds: [],
          selectedOperatorId: null,
          lastUpdated: Date.now()
        };
      }

      return {
        hiddenOperatorIds: parsed.hiddenOperatorIds || [],
        selectedOperatorId: typeof parsed.selectedOperatorId === 'string' ? parsed.selectedOperatorId : null,
        lastUpdated: parsed.lastUpdated || Date.now()
      };
    }
  } catch (error) {
    logger.warn('Failed to read operator preferences:', error);
  }

  // 默认值：空黑名单 = 全部显示
  return {
    hiddenOperatorIds: [],
    selectedOperatorId: null,
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
    logger.debug('Operator preferences saved:', toStore);
  } catch (error) {
    logger.error('Failed to save operator preferences:', error);
  }
}

/**
 * 检查操作员是否被启用（不在黑名单中）
 */
export function isOperatorEnabled(operatorId: string): boolean {
  const preferences = getOperatorPreferences();
  return !preferences.hiddenOperatorIds.includes(operatorId);
}

/**
 * 设置操作员启用状态
 */
export function setOperatorEnabled(operatorId: string, enabled: boolean): void {
  const preferences = getOperatorPreferences();
  const hiddenIds = new Set(preferences.hiddenOperatorIds);

  if (enabled) {
    hiddenIds.delete(operatorId);
  } else {
    hiddenIds.add(operatorId);
  }

  setOperatorPreferences({
    hiddenOperatorIds: Array.from(hiddenIds),
    selectedOperatorId: preferences.selectedOperatorId,
    lastUpdated: Date.now()
  });
}

/**
 * 设置所有操作员的启用状态
 */
export function setAllOperatorsEnabled(operatorIds: string[], enabled: boolean): void {
  if (enabled) {
    // 启用所有操作员 = 清空黑名单
    setOperatorPreferences({
      hiddenOperatorIds: [],
      selectedOperatorId: getOperatorPreferences().selectedOperatorId,
      lastUpdated: Date.now()
    });
  } else {
    // 禁用所有操作员 = 全部加入黑名单
    setOperatorPreferences({
      hiddenOperatorIds: [...operatorIds],
      selectedOperatorId: getOperatorPreferences().selectedOperatorId,
      lastUpdated: Date.now()
    });
  }
}

/**
 * 获取被隐藏的操作员ID列表
 */
export function getHiddenOperatorIds(): string[] {
  const preferences = getOperatorPreferences();
  return preferences.hiddenOperatorIds;
}

/**
 * 检查是否有主动隐藏的操作员
 */
export function hasHiddenOperators(): boolean {
  const preferences = getOperatorPreferences();
  return preferences.hiddenOperatorIds.length > 0;
}

/**
 * 获取握手消息的操作员配置
 * 黑名单模式下始终返回null（握手时不知道全部操作员，让服务端默认启用所有）
 * 握手完成后通过 setClientEnabledOperators 同步实际过滤列表
 */
export function getHandshakeOperatorIds(): string[] | null {
  return null;
}

export function getSelectedOperatorId(): string | null {
  return getOperatorPreferences().selectedOperatorId;
}

export function setSelectedOperatorId(operatorId: string | null): void {
  const preferences = getOperatorPreferences();
  setOperatorPreferences({
    hiddenOperatorIds: preferences.hiddenOperatorIds,
    selectedOperatorId: operatorId,
    lastUpdated: Date.now(),
  });
}

export function getHandshakeSelectedOperatorId(): string | null {
  return getSelectedOperatorId();
}
