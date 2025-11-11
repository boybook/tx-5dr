/**
 * ResourceManager 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceManager, IResource, ResourceState } from '../ResourceManager.js';
import { RadioError, RadioErrorCode } from '../errors/RadioError.js';

/**
 * 创建模拟资源
 */
function createMockResource(name: string, options?: {
  startDelay?: number;
  stopDelay?: number;
  shouldFailStart?: boolean;
  shouldFailStop?: boolean;
}): IResource {
  const {
    startDelay = 0,
    stopDelay = 0,
    shouldFailStart = false,
    shouldFailStop = false,
  } = options || {};

  let running = false;

  return {
    name,
    async start() {
      if (startDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, startDelay));
      }
      if (shouldFailStart) {
        throw new Error(`${name} start failed`);
      }
      running = true;
    },
    async stop() {
      if (stopDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, stopDelay));
      }
      if (shouldFailStop) {
        throw new Error(`${name} stop failed`);
      }
      running = false;
    },
    isRunning() {
      return running;
    },
  };
}

describe('ResourceManager', () => {
  let manager: ResourceManager;

  beforeEach(() => {
    manager = new ResourceManager();
  });

  describe('register/unregister', () => {
    it('注册资源', () => {
      const resource = createMockResource('test');
      manager.register({ resource });

      expect(manager.getState('test')).toBe(ResourceState.IDLE);
    });

    it('重复注册抛出错误', () => {
      const resource = createMockResource('test');
      manager.register({ resource });

      expect(() => {
        manager.register({ resource });
      }).toThrow('已注册');
    });

    it('取消注册资源', () => {
      const resource = createMockResource('test');
      manager.register({ resource });
      manager.unregister('test');

      expect(manager.getState('test')).toBeUndefined();
    });

    it('无法取消注册运行中的资源', async () => {
      const resource = createMockResource('test');
      manager.register({ resource });
      await manager.startAll();

      expect(() => {
        manager.unregister('test');
      }).toThrow();

      await manager.stopAll();
    });
  });

  describe('startAll/stopAll', () => {
    it('按优先级顺序启动资源', async () => {
      const startOrder: string[] = [];

      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');
      const resource3 = createMockResource('resource3');

      // 重写 start 方法以记录顺序
      const originalStart1 = resource1.start;
      resource1.start = async () => {
        startOrder.push('resource1');
        return originalStart1.call(resource1);
      };

      const originalStart2 = resource2.start;
      resource2.start = async () => {
        startOrder.push('resource2');
        return originalStart2.call(resource2);
      };

      const originalStart3 = resource3.start;
      resource3.start = async () => {
        startOrder.push('resource3');
        return originalStart3.call(resource3);
      };

      manager.register({ resource: resource1, priority: 3 });
      manager.register({ resource: resource2, priority: 1 });
      manager.register({ resource: resource3, priority: 2 });

      await manager.startAll();

      // 应该按 priority 1 -> 2 -> 3 顺序启动
      expect(startOrder).toEqual(['resource2', 'resource3', 'resource1']);

      await manager.stopAll();
    });

    it('按依赖关系顺序启动', async () => {
      const startOrder: string[] = [];

      const resourceA = createMockResource('A');
      const resourceB = createMockResource('B');
      const resourceC = createMockResource('C');

      resourceA.start = async () => {
        startOrder.push('A');
      };
      resourceB.start = async () => {
        startOrder.push('B');
      };
      resourceC.start = async () => {
        startOrder.push('C');
      };

      manager.register({ resource: resourceA, priority: 1 });
      manager.register({ resource: resourceB, priority: 1, dependencies: ['A'] });
      manager.register({ resource: resourceC, priority: 1, dependencies: ['B'] });

      await manager.startAll();

      // 应该按依赖顺序 A -> B -> C
      expect(startOrder).toEqual(['A', 'B', 'C']);

      await manager.stopAll();
    });

    it('启动失败时自动回滚', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2', { shouldFailStart: true });
      const resource3 = createMockResource('resource3');

      manager.register({ resource: resource1, priority: 1 });
      manager.register({ resource: resource2, priority: 2 });
      manager.register({ resource: resource3, priority: 3 });

      await expect(manager.startAll()).rejects.toThrow();

      // resource1 应该已回滚（停止）
      expect(resource1.isRunning()).toBe(false);
      expect(resource2.isRunning()).toBe(false);
      expect(resource3.isRunning()).toBe(false);
    });

    it('可选资源失败不影响其他资源', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2', { shouldFailStart: true });
      const resource3 = createMockResource('resource3');

      manager.register({ resource: resource1, priority: 1 });
      manager.register({ resource: resource2, priority: 2, optional: true });
      manager.register({ resource: resource3, priority: 3 });

      await manager.startAll();

      expect(resource1.isRunning()).toBe(true);
      expect(resource2.isRunning()).toBe(false);
      expect(resource3.isRunning()).toBe(true);

      await manager.stopAll();
    });

    it('按逆序停止资源', async () => {
      const stopOrder: string[] = [];

      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');
      const resource3 = createMockResource('resource3');

      resource1.stop = async () => {
        stopOrder.push('resource1');
      };
      resource2.stop = async () => {
        stopOrder.push('resource2');
      };
      resource3.stop = async () => {
        stopOrder.push('resource3');
      };

      manager.register({ resource: resource1, priority: 1 });
      manager.register({ resource: resource2, priority: 2 });
      manager.register({ resource: resource3, priority: 3 });

      await manager.startAll();
      await manager.stopAll();

      // 应该按启动的逆序停止
      expect(stopOrder).toEqual(['resource3', 'resource2', 'resource1']);
    });

    it('停止时单个资源失败不影响其他资源', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2', { shouldFailStop: true });
      const resource3 = createMockResource('resource3');

      manager.register({ resource: resource1 });
      manager.register({ resource: resource2 });
      manager.register({ resource: resource3 });

      await manager.startAll();
      await manager.stopAll();

      // 所有资源都应该尝试停止（即使 resource2 失败）
      expect(resource1.isRunning()).toBe(false);
      expect(resource3.isRunning()).toBe(false);
    });
  });

  describe('循环依赖检测', () => {
    it('检测直接循环依赖', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');

      manager.register({ resource: resource1, dependencies: ['resource2'] });
      manager.register({ resource: resource2, dependencies: ['resource1'] });

      await expect(manager.startAll()).rejects.toThrow('循环依赖');
    });

    it('检测间接循环依赖', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');
      const resource3 = createMockResource('resource3');

      manager.register({ resource: resource1, dependencies: ['resource2'] });
      manager.register({ resource: resource2, dependencies: ['resource3'] });
      manager.register({ resource: resource3, dependencies: ['resource1'] });

      await expect(manager.startAll()).rejects.toThrow('循环依赖');
    });

    it('检测未注册的依赖', async () => {
      const resource1 = createMockResource('resource1');

      manager.register({ resource: resource1, dependencies: ['notExists'] });

      await expect(manager.startAll()).rejects.toThrow('未注册');
    });
  });

  describe('超时处理', () => {
    it('启动超时', async () => {
      const resource = createMockResource('test', { startDelay: 200 });

      manager.register({ resource, startTimeout: 50 });

      await expect(manager.startAll()).rejects.toThrow('超时');
    });

    it('停止超时', async () => {
      const resource = createMockResource('test', { stopDelay: 200 });

      manager.register({ resource, stopTimeout: 50 });

      await manager.startAll();

      // stopAll 不会抛出错误，而是会捕获并记录错误后继续
      await manager.stopAll();

      // 资源状态应该是 ERROR（因为停止超时）
      expect(manager.getState('test')).toBe(ResourceState.ERROR);
    });
  });

  describe('状态查询', () => {
    it('获取单个资源状态', async () => {
      const resource = createMockResource('test');
      manager.register({ resource });

      expect(manager.getState('test')).toBe(ResourceState.IDLE);

      await manager.startAll();
      expect(manager.getState('test')).toBe(ResourceState.RUNNING);

      await manager.stopAll();
      expect(manager.getState('test')).toBe(ResourceState.STOPPED);
    });

    it('获取所有资源状态', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');

      manager.register({ resource: resource1 });
      manager.register({ resource: resource2 });

      await manager.startAll();

      const states = manager.getAllStates();
      expect(states.get('resource1')).toBe(ResourceState.RUNNING);
      expect(states.get('resource2')).toBe(ResourceState.RUNNING);

      await manager.stopAll();
    });
  });

  describe('clear', () => {
    it('清空所有资源注册', () => {
      const resource = createMockResource('test');
      manager.register({ resource });
      manager.clear();

      expect(manager.getState('test')).toBeUndefined();
    });

    it('有资源运行时无法清空', async () => {
      const resource = createMockResource('test');
      manager.register({ resource });
      await manager.startAll();

      expect(() => {
        manager.clear();
      }).toThrow();

      await manager.stopAll();
    });
  });
});
