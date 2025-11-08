/**
 * RadioError - 统一错误类型
 *
 * 提供分类的错误代码和用户友好的错误消息
 * 用于在整个系统中统一错误处理
 */

/**
 * 错误代码枚举
 */
export enum RadioErrorCode {
  // 连接错误 (1xxx)
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  CONNECTION_LOST = 'CONNECTION_LOST',
  RECONNECT_FAILED = 'RECONNECT_FAILED',
  RECONNECT_MAX_ATTEMPTS = 'RECONNECT_MAX_ATTEMPTS',

  // 配置错误 (2xxx)
  INVALID_CONFIG = 'INVALID_CONFIG',
  MISSING_CONFIG = 'MISSING_CONFIG',
  UNSUPPORTED_MODE = 'UNSUPPORTED_MODE',

  // 硬件错误 (3xxx)
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
  DEVICE_BUSY = 'DEVICE_BUSY',
  DEVICE_ERROR = 'DEVICE_ERROR',
  AUDIO_DEVICE_ERROR = 'AUDIO_DEVICE_ERROR',

  // 操作错误 (4xxx)
  INVALID_OPERATION = 'INVALID_OPERATION',
  OPERATION_TIMEOUT = 'OPERATION_TIMEOUT',
  OPERATION_CANCELLED = 'OPERATION_CANCELLED',
  PTT_ACTIVATION_FAILED = 'PTT_ACTIVATION_FAILED',

  // 状态错误 (5xxx)
  INVALID_STATE = 'INVALID_STATE',
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  ALREADY_RUNNING = 'ALREADY_RUNNING',
  NOT_RUNNING = 'NOT_RUNNING',

  // 资源错误 (6xxx)
  RESOURCE_UNAVAILABLE = 'RESOURCE_UNAVAILABLE',
  RESOURCE_CLEANUP_FAILED = 'RESOURCE_CLEANUP_FAILED',

  // 网络错误 (7xxx)
  NETWORK_ERROR = 'NETWORK_ERROR',
  UDP_ERROR = 'UDP_ERROR',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',

  // 未知错误
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * 错误级别
 */
export enum RadioErrorSeverity {
  /**
   * 致命错误 - 系统无法继续运行
   */
  CRITICAL = 'critical',

  /**
   * 错误 - 操作失败但系统可恢复
   */
  ERROR = 'error',

  /**
   * 警告 - 操作部分失败或使用降级方案
   */
  WARNING = 'warning',

  /**
   * 信息 - 仅供参考
   */
  INFO = 'info',
}

/**
 * RadioError 类
 */
export class RadioError extends Error {
  /**
   * 错误代码
   */
  public readonly code: RadioErrorCode;

  /**
   * 错误级别
   */
  public readonly severity: RadioErrorSeverity;

  /**
   * 用户友好的错误消息
   */
  public readonly userMessage: string;

  /**
   * 解决建议
   */
  public readonly suggestions: string[];

  /**
   * 原始错误
   */
  public readonly cause?: unknown;

  /**
   * 错误上下文（额外信息）
   */
  public readonly context?: Record<string, unknown>;

  /**
   * 时间戳
   */
  public readonly timestamp: number;

  constructor(options: {
    code: RadioErrorCode;
    message: string;
    userMessage?: string;
    severity?: RadioErrorSeverity;
    suggestions?: string[];
    cause?: unknown;
    context?: Record<string, unknown>;
  }) {
    super(options.message);

    this.name = 'RadioError';
    this.code = options.code;
    this.severity = options.severity || RadioErrorSeverity.ERROR;
    this.userMessage = options.userMessage || options.message;
    this.suggestions = options.suggestions || [];
    this.cause = options.cause;
    this.context = options.context;
    this.timestamp = Date.now();

    // 保持正确的原型链
    Object.setPrototypeOf(this, RadioError.prototype);
  }

  /**
   * 将普通错误转换为 RadioError
   */
  static from(error: unknown, code?: RadioErrorCode): RadioError {
    if (error instanceof RadioError) {
      return error;
    }

    if (error instanceof Error) {
      return new RadioError({
        code: code || RadioErrorCode.UNKNOWN_ERROR,
        message: error.message,
        cause: error,
      });
    }

    return new RadioError({
      code: code || RadioErrorCode.UNKNOWN_ERROR,
      message: String(error),
      cause: error,
    });
  }

  /**
   * 创建连接失败错误
   */
  static connectionFailed(message: string, cause?: unknown): RadioError {
    return new RadioError({
      code: RadioErrorCode.CONNECTION_FAILED,
      message: `连接失败: ${message}`,
      userMessage: '无法连接到电台',
      severity: RadioErrorSeverity.ERROR,
      suggestions: [
        '检查电台是否开机',
        '检查网络连接',
        '检查配置是否正确',
        '尝试重启电台',
      ],
      cause,
    });
  }

  /**
   * 创建设备未找到错误
   */
  static deviceNotFound(deviceName: string): RadioError {
    return new RadioError({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      message: `未找到设备: ${deviceName}`,
      userMessage: `未找到音频设备 "${deviceName}"`,
      severity: RadioErrorSeverity.ERROR,
      suggestions: [
        '检查设备是否已连接',
        '刷新设备列表',
        '选择其他可用设备',
      ],
      context: { deviceName },
    });
  }

  /**
   * 创建状态无效错误
   */
  static invalidState(
    operation: string,
    currentState: string,
    expectedState: string
  ): RadioError {
    return new RadioError({
      code: RadioErrorCode.INVALID_STATE,
      message: `无效的状态: 执行 ${operation} 时期望状态为 ${expectedState}，当前状态为 ${currentState}`,
      userMessage: `当前状态不允许执行此操作`,
      severity: RadioErrorSeverity.WARNING,
      context: { operation, currentState, expectedState },
    });
  }

  /**
   * 创建重连达到最大次数错误
   */
  static reconnectMaxAttempts(maxAttempts: number): RadioError {
    return new RadioError({
      code: RadioErrorCode.RECONNECT_MAX_ATTEMPTS,
      message: `重连失败: 已达到最大重试次数 ${maxAttempts}`,
      userMessage: `无法重新连接到电台 (已尝试 ${maxAttempts} 次)`,
      severity: RadioErrorSeverity.CRITICAL,
      suggestions: [
        '检查电台是否正常工作',
        '检查网络连接',
        '尝试手动重启系统',
        '联系技术支持',
      ],
      context: { maxAttempts },
    });
  }

  /**
   * 创建音频设备错误
   */
  static audioDeviceError(message: string, cause?: unknown): RadioError {
    return new RadioError({
      code: RadioErrorCode.AUDIO_DEVICE_ERROR,
      message: `音频设备错误: ${message}`,
      userMessage: '音频设备操作失败',
      severity: RadioErrorSeverity.ERROR,
      suggestions: [
        '检查音频设备是否可用',
        '尝试选择其他设备',
        '重启应用程序',
      ],
      cause,
    });
  }

  /**
   * 创建 PTT 激活失败错误
   */
  static pttActivationFailed(reason: string, cause?: unknown): RadioError {
    return new RadioError({
      code: RadioErrorCode.PTT_ACTIVATION_FAILED,
      message: `PTT 激活失败: ${reason}`,
      userMessage: '无法激活发射（PTT）',
      severity: RadioErrorSeverity.ERROR,
      suggestions: [
        '检查电台连接',
        '确认电台未被其他程序占用',
        '检查 PTT 配置',
      ],
      cause,
    });
  }

  /**
   * 转换为 JSON
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      severity: this.severity,
      suggestions: this.suggestions,
      context: this.context,
      timestamp: this.timestamp,
      cause: this.cause instanceof Error
        ? {
            name: this.cause.name,
            message: this.cause.message,
          }
        : this.cause,
    };
  }

  /**
   * 转换为字符串
   */
  toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}
