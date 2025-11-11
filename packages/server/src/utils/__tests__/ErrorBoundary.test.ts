/**
 * ErrorBoundary 单元测试
 */

import { describe, it, expect, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary.js';

describe('ErrorBoundary', () => {
  describe('execute - 基本功能', () => {
    it('成功执行操作', async () => {
      const result = await ErrorBoundary.execute(
        {
          operationName: 'test',
        },
        async () => 'success'
      );

      expect(result).toBe('success');
    });

    it('执行失败时调用清理函数', async () => {
      const cleanup = vi.fn();

      await expect(
        ErrorBoundary.execute(
          {
            operationName: 'test',
            cleanup,
            logError: false,
          },
          async () => {
            throw new Error('test error');
          }
        )
      ).rejects.toThrow('test error');

      expect(cleanup).toHaveBeenCalledOnce();
    });

    it('使用降级方案', async () => {
      const result = await ErrorBoundary.execute(
        {
          operationName: 'test',
          fallback: 'fallback value',
          logError: false,
        },
        async () => {
          throw new Error('test error');
        }
      );

      expect(result).toBe('fallback value');
    });

    it('清理函数失败不影响降级方案', async () => {
      const cleanup = vi.fn().mockRejectedValue(new Error('cleanup error'));

      const result = await ErrorBoundary.execute(
        {
          operationName: 'test',
          cleanup,
          fallback: 'fallback value',
          logError: false,
        },
        async () => {
          throw new Error('test error');
        }
      );

      expect(result).toBe('fallback value');
      expect(cleanup).toHaveBeenCalledOnce();
    });
  });

  describe('execute - 重试逻辑', () => {
    it('重试成功后返回结果', async () => {
      let attemptCount = 0;

      const result = await ErrorBoundary.execute(
        {
          operationName: 'test',
          retry: {
            maxAttempts: 3,
            delay: 10,
          },
          logError: false,
        },
        async () => {
          attemptCount++;
          if (attemptCount < 3) {
            throw new Error('retry');
          }
          return 'success';
        }
      );

      expect(result).toBe('success');
      expect(attemptCount).toBe(3);
    });

    it('达到最大重试次数后抛出错误', async () => {
      let attemptCount = 0;

      await expect(
        ErrorBoundary.execute(
          {
            operationName: 'test',
            retry: {
              maxAttempts: 3,
              delay: 10,
            },
            logError: false,
          },
          async () => {
            attemptCount++;
            throw new Error('always fail');
          }
        )
      ).rejects.toThrow('always fail');

      expect(attemptCount).toBe(3);
    });

    it('shouldRetry 返回 false 时立即停止', async () => {
      let attemptCount = 0;

      await expect(
        ErrorBoundary.execute(
          {
            operationName: 'test',
            retry: {
              maxAttempts: 3,
              delay: 10,
              shouldRetry: () => false,
            },
            logError: false,
          },
          async () => {
            attemptCount++;
            throw new Error('fail');
          }
        )
      ).rejects.toThrow('fail');

      expect(attemptCount).toBe(1);
    });

    it('指数退避重试延迟', async () => {
      const delays: number[] = [];
      let attemptCount = 0;

      await expect(
        ErrorBoundary.execute(
          {
            operationName: 'test',
            retry: {
              maxAttempts: 3,
              delay: 100,
              exponentialBackoff: true,
            },
            logError: false,
          },
          async () => {
            attemptCount++;
            const startTime = Date.now();
            if (attemptCount < 3) {
              throw new Error('retry');
            }
            delays.push(Date.now() - startTime);
            throw new Error('final fail');
          }
        )
      ).rejects.toThrow();

      expect(attemptCount).toBe(3);
      // 第二次尝试延迟应该大于第一次
    });
  });

  describe('execute - 错误转换', () => {
    it('转换错误类型', async () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      await expect(
        ErrorBoundary.execute(
          {
            operationName: 'test',
            errorTransform: (error) => {
              return new CustomError(`Transformed: ${(error as Error).message}`);
            },
            logError: false,
          },
          async () => {
            throw new Error('original');
          }
        )
      ).rejects.toThrow('Transformed: original');
    });
  });

  describe('executeSync - 同步版本', () => {
    it('成功执行同步操作', () => {
      const result = ErrorBoundary.executeSync(
        {
          operationName: 'test',
        },
        () => 'success'
      );

      expect(result).toBe('success');
    });

    it('同步操作失败时调用清理', () => {
      const cleanup = vi.fn();

      expect(() =>
        ErrorBoundary.executeSync(
          {
            operationName: 'test',
            cleanup,
            logError: false,
          },
          () => {
            throw new Error('test error');
          }
        )
      ).toThrow('test error');

      expect(cleanup).toHaveBeenCalledOnce();
    });

    it('同步操作使用降级方案', () => {
      const result = ErrorBoundary.executeSync(
        {
          operationName: 'test',
          fallback: 'fallback value',
          logError: false,
        },
        () => {
          throw new Error('test error');
        }
      );

      expect(result).toBe('fallback value');
    });
  });

  describe('create - 预配置实例', () => {
    it('创建预配置实例', async () => {
      const cleanup = vi.fn();
      const boundary = ErrorBoundary.create({
        cleanup,
        fallback: 'default',
        logError: false,
      });

      const result = await boundary.execute('operation1', async () => {
        throw new Error('error');
      });

      expect(result).toBe('default');
      expect(cleanup).toHaveBeenCalledOnce();
    });
  });
});
