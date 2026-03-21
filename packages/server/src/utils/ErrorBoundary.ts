import { createLogger } from './logger.js';

const logger = createLogger('ErrorBoundary');

/**
 * ErrorBoundary - 错误边界工具
 *
 * 提供统一的错误处理、清理函数和降级方案机制
 * 用于包装可能失败的操作，确保：
 * 1. 失败时自动调用清理函数
 * 2. 支持降级方案（fallback）
 * 3. 支持重试逻辑
 * 4. 错误转换和包装
 */

export interface ErrorBoundaryOptions<T, F = T> {
  /**
   * 操作名称，用于日志和错误消息
   */
  operationName: string;

  /**
   * 失败时的清理函数
   * 即使操作失败，也会被调用
   */
  cleanup?: () => void | Promise<void>;

  /**
   * 降级方案
   * 当操作失败时返回的默认值
   */
  fallback?: F;

  /**
   * 重试配置
   */
  retry?: {
    /**
     * 最大重试次数
     */
    maxAttempts: number;

    /**
     * 重试延迟（毫秒）
     */
    delay: number;

    /**
     * 是否使用指数退避
     */
    exponentialBackoff?: boolean;

    /**
     * 判断是否应该重试的函数
     * 返回 true 继续重试，false 直接抛出错误
     */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  };

  /**
   * 错误转换函数
   * 将捕获的错误转换为更友好的错误类型
   */
  errorTransform?: (error: unknown) => Error;

  /**
   * 是否在失败时记录错误日志
   * @default true
   */
  logError?: boolean;
}

/**
 * ErrorBoundary 类
 *
 * 使用示例：
 *
 * ```typescript
 * // 基本用法
 * const result = await ErrorBoundary.execute({
 *   operationName: 'connectToRadio',
 *   operation: async () => {
 *     return await radio.connect();
 *   },
 *   cleanup: async () => {
 *     await radio.disconnect();
 *   }
 * });
 *
 * // 使用降级方案
 * const config = await ErrorBoundary.execute({
 *   operationName: 'loadConfig',
 *   operation: async () => loadFromFile(),
 *   fallback: getDefaultConfig()
 * });
 *
 * // 带重试
 * const data = await ErrorBoundary.execute({
 *   operationName: 'fetchData',
 *   operation: async () => fetch('/api/data'),
 *   retry: {
 *     maxAttempts: 3,
 *     delay: 1000,
 *     exponentialBackoff: true,
 *     shouldRetry: (error) => error instanceof NetworkError
 *   }
 * });
 * ```
 */
export class ErrorBoundary {
  /**
   * 执行被保护的操作
   *
   * @param options - 配置选项
   * @param operation - 要执行的操作
   * @returns 操作结果，或降级值（如果提供）
   * @throws 如果操作失败且没有降级方案
   */
  static async execute<T, F = T>(
    options: ErrorBoundaryOptions<T, F>,
    operation: () => Promise<T> | T
  ): Promise<T | F> {
    const {
      operationName,
      cleanup,
      fallback,
      retry,
      errorTransform,
      logError = true,
    } = options;

    let lastError: unknown;
    const maxAttempts = retry ? retry.maxAttempts : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // 执行操作
        const result = await operation();
        return result;
      } catch (error) {
        lastError = error;

        // 转换错误
        const transformedError = errorTransform ? errorTransform(error) : error;

        // 判断是否应该重试
        if (retry && attempt < maxAttempts) {
          const shouldRetry = retry.shouldRetry
            ? retry.shouldRetry(transformedError, attempt)
            : true;

          if (shouldRetry) {
            // 计算延迟
            const delay = retry.exponentialBackoff
              ? retry.delay * Math.pow(2, attempt - 1)
              : retry.delay;

            if (logError) {
              logger.warn(
                `${operationName} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
                transformedError
              );
            }

            // 等待后重试
            await this.sleep(delay);
            continue;
          }
        }

        // 不再重试，执行清理
        if (logError) {
          logger.error(
            `${operationName} failed (attempt ${attempt}/${maxAttempts}):`,
            transformedError
          );
        }

        try {
          if (cleanup) {
            await cleanup();
            if (logError) {
              logger.debug(`${operationName} cleanup complete`);
            }
          }
        } catch (cleanupError) {
          logger.error(
            `${operationName} cleanup failed:`,
            cleanupError
          );
        }

        // 如果有降级方案，返回降级值
        if (fallback !== undefined) {
          if (logError) {
            logger.debug(`${operationName} using fallback`);
          }
          return fallback;
        }

        // 否则抛出错误
        throw transformedError;
      }
    }

    // 理论上不会到这里，但为了类型安全
    throw lastError;
  }

  /**
   * 同步版本的 execute
   *
   * @param options - 配置选项
   * @param operation - 要执行的同步操作
   * @returns 操作结果，或降级值（如果提供）
   * @throws 如果操作失败且没有降级方案
   */
  static executeSync<T, F = T>(
    options: Omit<ErrorBoundaryOptions<T, F>, 'cleanup' | 'retry'> & {
      cleanup?: () => void;
    },
    operation: () => T
  ): T | F {
    const { operationName, cleanup, fallback, errorTransform, logError = true } = options;

    try {
      return operation();
    } catch (error) {
      const transformedError = errorTransform ? errorTransform(error) : error;

      if (logError) {
        logger.error(
          `${operationName} failed:`,
          transformedError
        );
      }

      try {
        if (cleanup) {
          cleanup();
          if (logError) {
            logger.debug(`${operationName} cleanup complete`);
          }
        }
      } catch (cleanupError) {
        logger.error(
          `${operationName} cleanup failed:`,
          cleanupError
        );
      }

      if (fallback !== undefined) {
        if (logError) {
          logger.debug(`${operationName} using fallback`);
        }
        return fallback;
      }

      throw transformedError;
    }
  }

  /**
   * 创建一个预配置的 ErrorBoundary 实例
   * 适用于需要多次使用相同配置的场景
   */
  static create<T, F = T>(baseOptions: Omit<ErrorBoundaryOptions<T, F>, 'operationName'>) {
    return {
      execute: (operationName: string, operation: () => Promise<T> | T) =>
        ErrorBoundary.execute({ ...baseOptions, operationName }, operation),
      executeSync: (operationName: string, operation: () => T) =>
        ErrorBoundary.executeSync(
          {
            ...baseOptions,
            operationName,
            cleanup: baseOptions.cleanup as (() => void) | undefined,
          },
          operation
        ),
    };
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
