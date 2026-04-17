/**
 * 错误 Toast 工具函数
 *
 * 用于统一处理和显示错误提示，支持后端新的增强错误格式
 *
 * @module errorToast
 */

import { addToast } from '@heroui/toast';
import { Button } from '@heroui/react';
import { ApiError } from '@tx5dr/core';
import i18n from '../i18n/index';
import { createLogger } from './logger';

/**
 * 提取 error 对象的本地化用户消息：
 * - ApiError 带 userMessageKey 且 i18n 中存在 → 用 t() 翻译
 * - ApiError 否则 → userMessage
 * - 普通 Error → error.message
 * - 其他 → String(error)
 */
export function localizeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.userMessageKey && i18n.exists(error.userMessageKey)) {
      return i18n.t(error.userMessageKey, error.userMessageParams ?? {});
    }
    return error.userMessage;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

const logger = createLogger('ErrorToast');

/**
 * 错误 Toast 选项
 */
export interface ErrorToastOptions {
  /** 用户友好的错误提示（必需） */
  userMessage: string;

  /** 操作建议列表（可选） */
  suggestions?: string[];

  /** 错误严重程度（可选，默认为 'error'） */
  severity?: 'info' | 'warning' | 'error' | 'critical';

  /** 错误代码（可选） */
  code?: string;

  /** 操作按钮配置（可选） */
  action?: {
    label: string;
    handler: () => void;
  };

  /** 多个操作按钮配置（可选） */
  actions?: Array<{
    label: string;
    handler: () => void;
  }>;

  /** 技术错误详情（可选，仅开发环境显示） */
  technicalDetails?: string;

  /** 错误上下文（可选） */
  context?: Record<string, unknown>;
}

/**
 * 显示错误 Toast
 *
 * 根据错误严重程度自动配置颜色、持续时间等
 *
 * @param options - 错误 Toast 选项
 *
 * @example
 * ```typescript
 * // 基本用法
 * showErrorToast({
 *   userMessage: '电台启动失败',
 *   suggestions: ['请检查电台是否开机', '检查 USB 连接'],
 *   severity: 'error'
 * });
 *
 * // 带操作按钮
 * showErrorToast({
 *   userMessage: '连接断开',
 *   suggestions: ['点击重试按钮重新连接'],
 *   severity: 'warning',
 *   action: {
 *     label: '重试',
 *     handler: () => reconnect()
 *   }
 * });
 *
 * // 严重错误（不自动关闭）
 * showErrorToast({
 *   userMessage: '系统发生严重错误，请重启应用',
 *   severity: 'critical',
 *   code: 'SYSTEM_CRASH'
 * });
 * ```
 */
export function showErrorToast(options: ErrorToastOptions): void {
  const {
    userMessage,
    suggestions = [],
    severity = 'error',
    code,
    action,
    actions,
    technicalDetails,
    context
  } = options;

  // 构建描述文本：用户提示 + 建议
  let description = userMessage;

  if (suggestions.length > 0) {
    const suggestionText = suggestions
      .map((s) => `• ${i18n.exists(s) ? i18n.t(s) : s}`)
      .join('\n');
    description += '\n\n' + i18n.t('toast:suggestion.label') + '\n' + suggestionText;
  }

  // 开发环境显示技术详情
  if (import.meta.env.DEV && technicalDetails) {
    description += '\n\n[DEV] ' + technicalDetails;
  }

  // 映射 severity 到 HeroUI color
  const colorMap: Record<string, 'primary' | 'warning' | 'danger'> = {
    info: 'primary',
    warning: 'warning',
    error: 'danger',
    critical: 'danger'
  };

  const color = colorMap[severity] || 'danger';

  // 根据严重程度设置持续时间
  // critical: undefined（永不自动关闭，用户必须手动关闭）
  // error: 10000ms（10秒）
  // warning: 5000ms（5秒）
  // info: 3000ms（3秒）
  const timeoutMap: Record<string, number | undefined> = {
    critical: undefined,  // 永不关闭
    error: 10000,
    warning: 5000,
    info: 3000
  };

  const timeout = timeoutMap[severity] || 10000;

  // 构建操作按钮（如果提供）
  const normalizedActions = actions && actions.length > 0
    ? actions
    : action
      ? [action]
      : [];

  const endContent = normalizedActions.length > 0 ? (
    <div className="flex items-center gap-2">
      {normalizedActions.map((item) => (
        <Button
          key={item.label}
          size="sm"
          color="primary"
          variant="flat"
          onPress={item.handler}
        >
          {item.label}
        </Button>
      ))}
    </div>
  ) : undefined;

  // 设置标题
  const titleMap: Record<string, string> = {
    info: i18n.t('toast:severity.info'),
    warning: i18n.t('toast:severity.warning'),
    error: i18n.t('toast:severity.error'),
    critical: i18n.t('toast:severity.critical'),
  };

  const title = titleMap[severity] || i18n.t('toast:severity.error');

  // 记录完整的技术错误日志
  logger.error('Error toast shown:', {
    code,
    severity,
    userMessage,
    technicalDetails,
    suggestions,
    context,
    timestamp: new Date().toISOString()
  });

  // 显示 Toast
  addToast({
    title,
    description,
    color,
    timeout,
    endContent,
    hideCloseButton: false  // 始终显示关闭按钮
  });
}

/**
 * 快捷方法：显示信息提示
 */
export function showInfoToast(message: string, suggestions?: string[]): void {
  showErrorToast({
    userMessage: message,
    suggestions,
    severity: 'info'
  });
}

/**
 * 快捷方法：显示警告提示
 */
export function showWarningToast(message: string, suggestions?: string[]): void {
  showErrorToast({
    userMessage: message,
    suggestions,
    severity: 'warning'
  });
}

/**
 * 快捷方法：显示错误提示
 */
export function showError(message: string, suggestions?: string[]): void {
  showErrorToast({
    userMessage: message,
    suggestions,
    severity: 'error'
  });
}

/**
 * 快捷方法：显示严重错误提示
 */
export function showCriticalError(message: string, suggestions?: string[]): void {
  showErrorToast({
    userMessage: message,
    suggestions,
    severity: 'critical'
  });
}

// ========== 错误代码特殊处理辅助函数 ==========

/**
 * 创建"前往设置"操作
 */
export function createGoToSettingsAction(navigate: (path: string) => void, tab?: string) {
  return {
    label: i18n.t('common:action.goToSettings'),
    handler: () => {
      if (tab) {
        navigate(`/?settingsTab=${tab}`);
      } else {
        navigate('/?settings=true');
      }
    }
  };
}

/**
 * 创建"刷新状态"操作
 */
export function createRefreshStatusAction(onRefresh: () => void) {
  return {
    label: i18n.t('common:action.refreshStatus'),
    handler: onRefresh
  };
}

/**
 * 创建"重试"操作
 */
export function createRetryAction(onRetry: () => void) {
  return {
    label: i18n.t('common:action.retry'),
    handler: onRetry
  };
}

/**
 * 错误代码映射类型
 */
export type ErrorCode =
  | 'CONNECTION_FAILED'
  | 'DEVICE_NOT_FOUND'
  | 'CONFIG_ERROR'
  | 'INVALID_FREQUENCY'
  | 'INVALID_MODE'
  | 'STATE_CONFLICT'
  | 'RESOURCE_BUSY'
  | 'TIMEOUT'
  | 'RADIO_DISCONNECTED'
  | 'ENGINE_START_FAILED'
  | string;

/**
 * 检查错误代码是否需要重试操作
 */
export function isRetryableError(code?: string): boolean {
  if (!code) return false;

  const retryableCodes: ErrorCode[] = [
    'CONNECTION_FAILED',
    'TIMEOUT',
    'RESOURCE_BUSY',
    'ENGINE_START_FAILED'
  ];

  return retryableCodes.includes(code as ErrorCode);
}

/**
 * 检查错误代码是否需要前往设置
 */
export function needsSettingsAction(code?: string): boolean {
  if (!code) return false;

  const settingsCodes: ErrorCode[] = [
    'DEVICE_NOT_FOUND',
    'CONFIG_ERROR',
    'INVALID_FREQUENCY',
    'INVALID_MODE'
  ];

  return settingsCodes.includes(code as ErrorCode);
}
