/**
 * radioStateMachine unit tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRadioActor,
  isRadioState,
  getRadioContext,
  waitForRadioState,
} from '../radioStateMachine.js';
import { RadioState, type RadioInput } from '../types.js';
import type { HamlibConfig } from '@tx5dr/contracts';

describe('radioStateMachine', () => {
  let mockInput: RadioInput;
  let mockConfig: HamlibConfig;

  beforeEach(() => {
    mockConfig = {
      type: 'icom-wlan',
      icomWlan: {
        ip: '192.168.1.100',
        port: 50001,
        dataMode: true,
      },
    };

    mockInput = {
      onConnect: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn().mockResolvedValue(undefined),
      onHealthCheck: vi.fn().mockResolvedValue(true),
      onError: vi.fn(),
      onStateChange: vi.fn(),
      healthCheckInterval: 500,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    it('initial state should be disconnected', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      expect(actor.getSnapshot().value).toBe(RadioState.DISCONNECTED);
      expect(isRadioState(actor, RadioState.DISCONNECTED)).toBe(true);

      actor.stop();
    });

    it('initial context should contain health status', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      const context = getRadioContext(actor);
      expect(context.isHealthy).toBe(false);

      actor.stop();
    });
  });

  describe('Connection flow', () => {
    it('successful connection: disconnected → connecting → connected', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });

      // Wait for onConnect to be called
      await vi.waitFor(() => {
        expect(mockInput.onConnect).toHaveBeenCalledWith(mockConfig);
      });

      // Wait for transition to connected state
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      expect(isRadioState(actor, RadioState.CONNECTED)).toBe(true);

      const context = getRadioContext(actor);
      expect(context.config).toEqual(mockConfig);
      expect(context.isHealthy).toBe(true);
      expect(context.connectedTimestamp).toBeDefined();

      actor.stop();
    });

    it('connection failure should return to disconnected', async () => {
      const testError = new Error('connection failed');
      mockInput.onConnect = vi.fn().mockRejectedValue(testError);

      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });

      // First connection failure returns directly to disconnected (does not enter error)
      await waitForRadioState(actor, RadioState.DISCONNECTED, 1000);

      expect(isRadioState(actor, RadioState.DISCONNECTED)).toBe(true);

      actor.stop();
    });
  });

  describe('Disconnect flow', () => {
    it('voluntary disconnect: connected → disconnected', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      // Connect first
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      // Disconnect
      actor.send({ type: 'DISCONNECT', reason: 'user initiated disconnect' });
      await waitForRadioState(actor, RadioState.DISCONNECTED, 1000);

      const context = getRadioContext(actor);
      expect(context.disconnectReason).toBe('user initiated disconnect');

      actor.stop();
    });

    it('connection lost (was ever connected): connected → reconnecting', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      // Connect first
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      // Connection lost → wasEverConnected=true → auto reconnect
      actor.send({ type: 'CONNECTION_LOST', reason: 'network interrupted' });
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      const context = getRadioContext(actor);
      expect(context.disconnectReason).toBe('network interrupted');

      actor.stop();
    });
  });

  describe('Reconnection mechanism', () => {
    it('can reconnect after connection failure: disconnected → connecting → connected', async () => {
      let failOnce = true;
      mockInput.onConnect = vi.fn().mockImplementation(() => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('first attempt failed'));
        }
        return Promise.resolve();
      });

      const actor = createRadioActor(mockInput);
      actor.start();

      // First connection fails → return to disconnected
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.DISCONNECTED, 1000);

      // Reconnect
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.CONNECTED, 2000);

      expect(isRadioState(actor, RadioState.CONNECTED)).toBe(true);

      actor.stop();
    });
  });

  describe('Health check', () => {
    it('health check failure (was ever connected) should enter reconnecting state', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      // Connect first
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      // Health check failure → wasEverConnected=true → auto reconnect
      actor.send({
        type: 'HEALTH_CHECK_FAILED',
        error: new Error('health check failed'),
      });
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      actor.stop();
    });
  });

  describe('Utility functions', () => {
    it('isRadioState should support single state', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      expect(isRadioState(actor, RadioState.DISCONNECTED)).toBe(true);
      expect(isRadioState(actor, RadioState.CONNECTED)).toBe(false);

      actor.stop();
    });

    it('isRadioState should support multiple states', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      expect(
        isRadioState(actor, [
          RadioState.DISCONNECTED,
          RadioState.CONNECTED,
        ])
      ).toBe(true);
      expect(
        isRadioState(actor, [
          RadioState.CONNECTING,
          RadioState.RECONNECTING,
        ])
      ).toBe(false);

      actor.stop();
    });

    it('getRadioContext should return current context', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      const context = getRadioContext(actor);
      expect(context).toBeDefined();
      expect(context.isHealthy).toBe(false);

      actor.stop();
    });

    it('waitForRadioState should throw on timeout', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      await expect(
        waitForRadioState(actor, RadioState.CONNECTED, 100)
      ).rejects.toThrow('Waiting for state connected timed out');

      actor.stop();
    });
  });
});
