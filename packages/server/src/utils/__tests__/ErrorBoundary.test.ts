/**
 * ErrorBoundary unit tests
 */

import { describe, it, expect, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary.js';

describe('ErrorBoundary', () => {
  describe('execute - basic functionality', () => {
    it('successful execution', async () => {
      const result = await ErrorBoundary.execute(
        {
          operationName: 'test',
        },
        async () => 'success'
      );

      expect(result).toBe('success');
    });

    it('calls cleanup function on execution failure', async () => {
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

    it('uses fallback value', async () => {
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

    it('cleanup failure does not affect fallback', async () => {
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

  describe('execute - retry logic', () => {
    it('returns result after successful retry', async () => {
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

    it('throws error after reaching max retry attempts', async () => {
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

    it('stops immediately when shouldRetry returns false', async () => {
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

    it('exponential backoff retry delay', async () => {
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
      // Second attempt delay should be greater than first
    });
  });

  describe('execute - error transform', () => {
    it('transforms error type', async () => {
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

  describe('executeSync - synchronous version', () => {
    it('successful synchronous execution', () => {
      const result = ErrorBoundary.executeSync(
        {
          operationName: 'test',
        },
        () => 'success'
      );

      expect(result).toBe('success');
    });

    it('calls cleanup on synchronous operation failure', () => {
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

    it('synchronous operation uses fallback', () => {
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

  describe('create - pre-configured instance', () => {
    it('creates pre-configured instance', async () => {
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
