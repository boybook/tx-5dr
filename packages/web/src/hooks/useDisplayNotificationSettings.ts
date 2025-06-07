import { useState, useEffect } from 'react';
import {
  type DisplayNotificationSettings,
  HighlightType,
  getDisplayNotificationSettings,
} from '../utils/displayNotificationSettings';

/**
 * 自定义Hook，用于管理显示通知设置
 */
export function useDisplayNotificationSettings() {
  const [settings, setSettings] = useState<DisplayNotificationSettings>(getDisplayNotificationSettings());

  // 监听localStorage变化
  useEffect(() => {
    const handleStorageChange = () => {
      setSettings(getDisplayNotificationSettings());
    };

    // 监听storage事件（跨标签页同步）
    window.addEventListener('storage', handleStorageChange);
    
    // 监听自定义事件（同标签页内的设置更新）
    window.addEventListener('displaySettingsChanged', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('displaySettingsChanged', handleStorageChange);
    };
  }, []);

  // 检查是否启用了高亮显示
  const isHighlightEnabled = (type: HighlightType): boolean => {
    return settings.enabled && settings.highlights[type].enabled;
  };

  // 获取高亮颜色
  const getHighlightColor = (type: HighlightType): string => {
    return settings.highlights[type].color;
  };

  // 获取最高优先级的高亮类型
  const getHighestPriorityHighlight = (analysis: {
    isNewGrid?: boolean;
    isNewPrefix?: boolean;
    isNewCallsign?: boolean;
  }): HighlightType | null => {
    if (!settings.enabled) return null;

    // 按优先级顺序检查：新网格 > 新前缀 > 新呼号
    if (analysis.isNewGrid && settings.highlights.newGrid.enabled) {
      return HighlightType.NEW_GRID;
    }
    if (analysis.isNewPrefix && settings.highlights.newPrefix.enabled) {
      return HighlightType.NEW_PREFIX;
    }
    if (analysis.isNewCallsign && settings.highlights.newCallsign.enabled) {
      return HighlightType.NEW_CALLSIGN;
    }

    return null;
  };

  return {
    settings,
    isHighlightEnabled,
    getHighlightColor,
    getHighestPriorityHighlight,
  };
} 