/**
 * ResourceManager unit tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResourceManager, IResource, ResourceState } from '../ResourceManager.js';


/**
 * Create mock resource
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
    it('register resource', () => {
      const resource = createMockResource('test');
      manager.register({ resource });

      expect(manager.getState('test')).toBe(ResourceState.IDLE);
    });

    it('throws error on duplicate registration', () => {
      const resource = createMockResource('test');
      manager.register({ resource });

      expect(() => {
        manager.register({ resource });
      }).toThrow('already registered');
    });

    it('unregister resource', () => {
      const resource = createMockResource('test');
      manager.register({ resource });
      manager.unregister('test');

      expect(manager.getState('test')).toBeUndefined();
    });

    it('cannot unregister running resource', async () => {
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
    it('starts resources in priority order', async () => {
      const startOrder: string[] = [];

      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');
      const resource3 = createMockResource('resource3');

      // Override start method to record order
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

      // Should start in priority 1 -> 2 -> 3 order
      expect(startOrder).toEqual(['resource2', 'resource3', 'resource1']);

      await manager.stopAll();
    });

    it('starts in dependency order', async () => {
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

      // Should start in dependency order A -> B -> C
      expect(startOrder).toEqual(['A', 'B', 'C']);

      await manager.stopAll();
    });

    it('automatically rolls back on start failure', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2', { shouldFailStart: true });
      const resource3 = createMockResource('resource3');

      manager.register({ resource: resource1, priority: 1 });
      manager.register({ resource: resource2, priority: 2 });
      manager.register({ resource: resource3, priority: 3 });

      await expect(manager.startAll()).rejects.toThrow();

      // resource1 should have been rolled back (stopped)
      expect(resource1.isRunning()).toBe(false);
      expect(resource2.isRunning()).toBe(false);
      expect(resource3.isRunning()).toBe(false);
    });

    it('optional resource failure does not affect other resources', async () => {
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

    it('stops resources in reverse order', async () => {
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

      // Should stop in reverse order of startup
      expect(stopOrder).toEqual(['resource3', 'resource2', 'resource1']);
    });

    it('single resource stop failure does not affect other resources', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2', { shouldFailStop: true });
      const resource3 = createMockResource('resource3');

      manager.register({ resource: resource1 });
      manager.register({ resource: resource2 });
      manager.register({ resource: resource3 });

      await manager.startAll();
      await manager.stopAll();

      // All resources should attempt to stop (even if resource2 fails)
      expect(resource1.isRunning()).toBe(false);
      expect(resource3.isRunning()).toBe(false);
    });
  });

  describe('Circular dependency detection', () => {
    it('detects direct circular dependency', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');

      manager.register({ resource: resource1, dependencies: ['resource2'] });
      manager.register({ resource: resource2, dependencies: ['resource1'] });

      await expect(manager.startAll()).rejects.toThrow('Circular dependency detected');
    });

    it('detects indirect circular dependency', async () => {
      const resource1 = createMockResource('resource1');
      const resource2 = createMockResource('resource2');
      const resource3 = createMockResource('resource3');

      manager.register({ resource: resource1, dependencies: ['resource2'] });
      manager.register({ resource: resource2, dependencies: ['resource3'] });
      manager.register({ resource: resource3, dependencies: ['resource1'] });

      await expect(manager.startAll()).rejects.toThrow('Circular dependency detected');
    });

    it('detects unregistered dependency', async () => {
      const resource1 = createMockResource('resource1');

      manager.register({ resource: resource1, dependencies: ['notExists'] });

      await expect(manager.startAll()).rejects.toThrow('is not registered');
    });
  });

  describe('Timeout handling', () => {
    it('start timeout', async () => {
      const resource = createMockResource('test', { startDelay: 200 });

      manager.register({ resource, startTimeout: 50 });

      await expect(manager.startAll()).rejects.toThrow('timed out');
    });

    it('stop timeout', async () => {
      const resource = createMockResource('test', { stopDelay: 200 });

      manager.register({ resource, stopTimeout: 50 });

      await manager.startAll();

      // stopAll does not throw, it captures and logs errors then continues
      await manager.stopAll();

      // Resource state should be ERROR (due to stop timeout)
      expect(manager.getState('test')).toBe(ResourceState.ERROR);
    });
  });

  describe('State query', () => {
    it('get single resource state', async () => {
      const resource = createMockResource('test');
      manager.register({ resource });

      expect(manager.getState('test')).toBe(ResourceState.IDLE);

      await manager.startAll();
      expect(manager.getState('test')).toBe(ResourceState.RUNNING);

      await manager.stopAll();
      expect(manager.getState('test')).toBe(ResourceState.STOPPED);
    });

    it('get all resource states', async () => {
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
    it('clears all resource registrations', () => {
      const resource = createMockResource('test');
      manager.register({ resource });
      manager.clear();

      expect(manager.getState('test')).toBeUndefined();
    });

    it('cannot clear while resources are running', async () => {
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
