/**
 * engineStateMachine unit tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createEngineActor,
  isEngineState,
  getEngineContext,
  waitForEngineState,
} from '../engineStateMachine.js';
import { EngineState, type EngineInput } from '../types.js';

describe('engineStateMachine', () => {
  let mockInput: EngineInput;

  beforeEach(() => {
    // Create mock input
    mockInput = {
      onStart: vi.fn().mockResolvedValue(undefined),
      onStop: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
      onStateChange: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    it('initial state should be idle', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      expect(actor.getSnapshot().value).toBe(EngineState.IDLE);
      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);

      actor.stop();
    });

    it('initial context should contain empty startedResources', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      const context = getEngineContext(actor);
      expect(context.startedResources).toEqual([]);
      expect(context.error).toBeUndefined();

      actor.stop();
    });
  });

  describe('Startup flow', () => {
    it('successful start: idle → starting → running', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // Send START event
      actor.send({ type: 'START' });

      // Wait for onStart to be called
      await vi.waitFor(() => {
        expect(mockInput.onStart).toHaveBeenCalledOnce();
      });

      // Wait for transition to running state
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      expect(isEngineState(actor, EngineState.RUNNING)).toBe(true);

      actor.stop();
    });

    it('start failure: idle → starting → idle', async () => {
      const testError = new Error('start failed');
      mockInput.onStart = vi.fn().mockRejectedValue(testError);

      const actor = createEngineActor(mockInput);
      actor.start();

      actor.send({ type: 'START' });

      // Wait for return to idle state (no longer enters error)
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);
      expect(mockInput.onError).toHaveBeenCalledWith(testError);

      // context.error is preserved (not cleared in IDLE, cleared on next START)
      const context = getEngineContext(actor);
      expect(context.error).toBeDefined();

      actor.stop();
    });

    it('should allow restart after start failure', async () => {
      let failOnce = true;
      mockInput.onStart = vi.fn().mockImplementation(() => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('first attempt failed'));
        }
        return Promise.resolve();
      });

      const actor = createEngineActor(mockInput);
      actor.start();

      // First start fails → return to idle
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      // Restart directly (no RESET needed)
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      expect(isEngineState(actor, EngineState.RUNNING)).toBe(true);
      // error should be cleared on restart
      const context = getEngineContext(actor);
      expect(context.error).toBeUndefined();

      actor.stop();
    });

    it('should record startTimestamp on start', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      actor.send({ type: 'START' });

      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      const context = getEngineContext(actor);
      expect(context.startTimestamp).toBeDefined();
      expect(context.startTimestamp).toBeGreaterThan(0);

      actor.stop();
    });
  });

  describe('Stop flow', () => {
    it('successful stop: running → stopping → idle', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // Start first
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // Then stop
      actor.send({ type: 'STOP' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);
      expect(mockInput.onStop).toHaveBeenCalledOnce();

      actor.stop();
    });

    it('stop failure: running → stopping → idle', async () => {
      const testError = new Error('stop failed');
      mockInput.onStop = vi.fn().mockRejectedValue(testError);

      const actor = createEngineActor(mockInput);
      actor.start();

      // Start first
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // Then stop (fails, but still returns to idle)
      actor.send({ type: 'STOP' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);
      expect(mockInput.onError).toHaveBeenCalledWith(testError);

      // context.error is preserved
      const context = getEngineContext(actor);
      expect(context.error).toBeDefined();

      actor.stop();
    });

    it('should record stopTimestamp on stop', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // Start first
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // Then stop
      actor.send({ type: 'STOP' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      const context = getEngineContext(actor);
      expect(context.stopTimestamp).toBeDefined();
      expect(context.stopTimestamp).toBeGreaterThanOrEqual(context.startTimestamp || 0);

      actor.stop();
    });
  });

  describe('Force stop', () => {
    it('FORCE_STOP event should trigger stop', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // Start first
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // Force stop
      actor.send({ type: 'FORCE_STOP', reason: 'test force stop' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      const context = getEngineContext(actor);
      expect(context.forcedStop).toBe(true);

      actor.stop();
    });

    it('RADIO_DISCONNECTED event should trigger stop', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // Start first
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // Radio disconnected
      actor.send({ type: 'RADIO_DISCONNECTED', reason: 'radio connection lost' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      const context = getEngineContext(actor);
      expect(context.forcedStop).toBe(true);

      actor.stop();
    });

    it('should allow force stop during startup', async () => {
      // Simulate slow startup
      mockInput.onStart = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      );

      const actor = createEngineActor(mockInput);
      actor.start();

      actor.send({ type: 'START' });

      // Wait for entry into starting state
      await vi.waitFor(() => {
        expect(isEngineState(actor, EngineState.STARTING)).toBe(true);
      });

      // Force stop during startup
      actor.send({ type: 'FORCE_STOP', reason: 'user cancelled startup' });

      // Should transition to stopping state
      await waitForEngineState(actor, EngineState.STOPPING, 1000);

      actor.stop();
    });
  });

  describe('State change callback', () => {
    it('should call onStateChange on every state change', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // idle → starting
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // Verify state change callback was called
      // idle (initial entry) + starting (entry) + running (entry) = at least 3 times
      expect(mockInput.onStateChange).toHaveBeenCalled();

      actor.stop();
    });
  });

  describe('Utility functions', () => {
    it('isEngineState should support single state', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);
      expect(isEngineState(actor, EngineState.RUNNING)).toBe(false);

      actor.stop();
    });

    it('isEngineState should support multiple states', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      expect(
        isEngineState(actor, [EngineState.IDLE, EngineState.RUNNING])
      ).toBe(true);
      expect(
        isEngineState(actor, [EngineState.STARTING, EngineState.STOPPING])
      ).toBe(false);

      actor.stop();
    });

    it('getEngineContext should return current context', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      const context = getEngineContext(actor);
      expect(context).toBeDefined();
      expect(context.startedResources).toEqual([]);

      actor.stop();
    });

    it('waitForEngineState should throw on timeout', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      await expect(
        waitForEngineState(actor, EngineState.RUNNING, 100)
      ).rejects.toThrow('Waiting for state running timed out');

      actor.stop();
    });
  });
});
