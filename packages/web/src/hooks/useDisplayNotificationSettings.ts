import { useState, useEffect, useCallback } from 'react';
import {
  type DisplayNotificationSettings,
  HighlightType,
  getDisplayNotificationSettings,
  type HighlightAnalysis,
  resolveHighestPriorityHighlight,
} from '../utils/displayNotificationSettings';

/**
 * 自定义Hook，用于管理显示通知设置
 */
export function useDisplayNotificationSettings() {
  const [settings, setSettings] = useState<DisplayNotificationSettings>(getDisplayNotificationSettings);

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
  const isHighlightEnabled = useCallback((type: HighlightType): boolean => {
    return settings.enabled && settings.highlights[type].enabled;
  }, [settings]);

  // 获取高亮颜色
  const getHighlightColor = useCallback((type: HighlightType): string => {
    return settings.highlights[type].color;
  }, [settings]);

  // 获取最高优先级的高亮类型
  const getHighestPriorityHighlight = useCallback((analysis: HighlightAnalysis): HighlightType | null => {
    return resolveHighestPriorityHighlight(analysis, settings);
  }, [settings]);

  return {
    settings,
    isHighlightEnabled,
    getHighlightColor,
    getHighestPriorityHighlight,
  };
} 
