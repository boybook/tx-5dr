import i18n from '../i18n/index';
import { createLogger } from './logger';

const logger = createLogger('DisplayNotificationSettings');
// 显示通知设置类型定义
export interface HighlightConfig {
  enabled: boolean;
  color: string;
}

export interface FrameTableCycleBackgrounds {
  light: {
    even: string;
    odd: string;
  };
  dark: {
    even: string;
    odd: string;
  };
}

export interface DisplayNotificationSettings {
  enabled: boolean; // 全局开关
  highlights: {
    newGrid: HighlightConfig;
    newPrefix: HighlightConfig;
    newCallsign: HighlightConfig;
  };
  frameTableCycleBackgrounds: FrameTableCycleBackgrounds;
}

// 默认设置
export const DEFAULT_DISPLAY_SETTINGS: DisplayNotificationSettings = {
  enabled: true,
  highlights: {
    newGrid: {
      enabled: true,
      color: '#a855f7', // purple-500
    },
    newPrefix: {
      enabled: true,
      color: '#22d3ee', // cyan-400
    },
    newCallsign: {
      enabled: true,
      color: '#fbbf24', // amber-400
    },
  },
  frameTableCycleBackgrounds: {
    light: {
      even: 'rgba(153, 255, 145, 0.2)',
      odd: 'rgba(255, 205, 148, 0.2)',
    },
    dark: {
      even: 'rgba(5, 150, 105, 0.25)',
      odd: 'rgba(217, 119, 6, 0.25)',
    },
  },
};

// 预设颜色选项
export const PRESET_COLORS = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#fbbf24', // amber-400
  '#22c55e', // green-500
  '#10b981', // emerald-500
  '#06b6d4', // cyan-500
  '#22d3ee', // cyan-400
  '#3b82f6', // blue-500
  '#6366f1', // indigo-500
  '#8b5cf6', // violet-500
  '#a855f7', // purple-500
  '#d946ef', // fuchsia-500
  '#ec4899', // pink-500
];

// 高亮类型枚举
export enum HighlightType {
  NEW_GRID = 'newGrid',
  NEW_PREFIX = 'newPrefix',
  NEW_CALLSIGN = 'newCallsign',
}

export interface HighlightAnalysis {
  isNewGrid?: boolean;
  isNewDxccEntity?: boolean;
  isNewPrefix?: boolean;
  isNewCallsign?: boolean;
}

export const HIGHLIGHT_TYPES_BY_PRIORITY: HighlightType[] = [
  HighlightType.NEW_PREFIX,
  HighlightType.NEW_GRID,
  HighlightType.NEW_CALLSIGN,
];

// 高亮类型显示名称工厂函数（支持 i18n）
export function getHighlightTypeLabels(t: (key: string) => string): Record<HighlightType, string> {
  return {
    [HighlightType.NEW_GRID]: t('settings:highlight.label.grid'),
    [HighlightType.NEW_PREFIX]: t('settings:highlight.label.dxcc'),
    [HighlightType.NEW_CALLSIGN]: t('settings:highlight.label.myCall'),
  };
}

// 高亮类型描述工厂函数（支持 i18n）
export function getHighlightTypeDescriptions(t: (key: string) => string): Record<HighlightType, string> {
  return {
    [HighlightType.NEW_GRID]: t('settings:highlight.description.grid'),
    [HighlightType.NEW_PREFIX]: t('settings:highlight.description.dxcc'),
    [HighlightType.NEW_CALLSIGN]: t('settings:highlight.description.myCall'),
  };
}

const STORAGE_KEY = 'tx5dr_display_notification_settings';

function cloneDefaultSettings(): DisplayNotificationSettings {
  return {
    enabled: DEFAULT_DISPLAY_SETTINGS.enabled,
    highlights: {
      newGrid: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newGrid },
      newPrefix: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newPrefix },
      newCallsign: { ...DEFAULT_DISPLAY_SETTINGS.highlights.newCallsign },
    },
    frameTableCycleBackgrounds: {
      light: { ...DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.light },
      dark: { ...DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.dark },
    },
  };
}

export function getDefaultDisplayNotificationSettings(): DisplayNotificationSettings {
  return cloneDefaultSettings();
}

function mergeDisplayNotificationSettings(parsed: Partial<DisplayNotificationSettings> | null | undefined): DisplayNotificationSettings {
  return {
    enabled: parsed?.enabled ?? DEFAULT_DISPLAY_SETTINGS.enabled,
    highlights: {
      newGrid: {
        enabled: parsed?.highlights?.newGrid?.enabled ?? DEFAULT_DISPLAY_SETTINGS.highlights.newGrid.enabled,
        color: parsed?.highlights?.newGrid?.color ?? DEFAULT_DISPLAY_SETTINGS.highlights.newGrid.color,
      },
      newPrefix: {
        enabled: parsed?.highlights?.newPrefix?.enabled ?? DEFAULT_DISPLAY_SETTINGS.highlights.newPrefix.enabled,
        color: parsed?.highlights?.newPrefix?.color ?? DEFAULT_DISPLAY_SETTINGS.highlights.newPrefix.color,
      },
      newCallsign: {
        enabled: parsed?.highlights?.newCallsign?.enabled ?? DEFAULT_DISPLAY_SETTINGS.highlights.newCallsign.enabled,
        color: parsed?.highlights?.newCallsign?.color ?? DEFAULT_DISPLAY_SETTINGS.highlights.newCallsign.color,
      },
    },
    frameTableCycleBackgrounds: {
      light: {
        even: parsed?.frameTableCycleBackgrounds?.light?.even ?? DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.light.even,
        odd: parsed?.frameTableCycleBackgrounds?.light?.odd ?? DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.light.odd,
      },
      dark: {
        even: parsed?.frameTableCycleBackgrounds?.dark?.even ?? DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.dark.even,
        odd: parsed?.frameTableCycleBackgrounds?.dark?.odd ?? DEFAULT_DISPLAY_SETTINGS.frameTableCycleBackgrounds.dark.odd,
      },
    },
  };
}

/**
 * 从localStorage读取显示通知设置
 */
export function getDisplayNotificationSettings(): DisplayNotificationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return cloneDefaultSettings();
    }

    const parsed = JSON.parse(stored);
    return mergeDisplayNotificationSettings(parsed);
  } catch (error) {
    logger.error('Failed to read display notification settings:', error);
    return cloneDefaultSettings();
  }
}

/**
 * 保存显示通知设置到localStorage
 */
export function saveDisplayNotificationSettings(settings: DisplayNotificationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    // 触发自定义事件，通知其他组件设置已更新
    window.dispatchEvent(new CustomEvent('displaySettingsChanged'));
  } catch (error) {
    logger.error('Failed to save display notification settings:', error);
    throw new Error(i18n.t('settings:saveFailed'));
  }
}

/**
 * 重置设置为默认值
 */
export function resetDisplayNotificationSettings(): DisplayNotificationSettings {
  const defaultSettings = getDefaultDisplayNotificationSettings();
  saveDisplayNotificationSettings(defaultSettings);
  return defaultSettings;
}

/**
 * 检查设置是否与默认值相同
 */
export function isDefaultSettings(settings: DisplayNotificationSettings): boolean {
  return JSON.stringify(settings) === JSON.stringify(DEFAULT_DISPLAY_SETTINGS);
}

/**
 * 验证颜色值是否有效
 */
export function isValidColor(color: string): boolean {
  const s = new Option().style;
  s.color = color;
  return s.color !== '';
}

/**
 * 获取高亮类型的优先级（数字越小优先级越高）
 */
export function getHighlightPriority(type: HighlightType): number {
  switch (type) {
    case HighlightType.NEW_PREFIX:
      return 1;
    case HighlightType.NEW_GRID:
      return 2;
    case HighlightType.NEW_CALLSIGN:
      return 3;
    default:
      return 999;
  }
}

export function getOrderedHighlightTypes(): HighlightType[] {
  return [...HIGHLIGHT_TYPES_BY_PRIORITY];
}

export function resolveHighestPriorityHighlight(
  analysis: HighlightAnalysis,
  settings: DisplayNotificationSettings,
): HighlightType | null {
  if (!settings.enabled) {
    return null;
  }

  if ((analysis.isNewDxccEntity || analysis.isNewPrefix) && settings.highlights.newPrefix.enabled) {
    return HighlightType.NEW_PREFIX;
  }

  if (analysis.isNewGrid && settings.highlights.newGrid.enabled) {
    return HighlightType.NEW_GRID;
  }

  if (analysis.isNewCallsign && settings.highlights.newCallsign.enabled) {
    return HighlightType.NEW_CALLSIGN;
  }

  return null;
}
