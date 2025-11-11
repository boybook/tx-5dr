/**
 * radioStateMachine 单元测试
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
      maxReconnectAttempts: 3,
      reconnectDelay: 100, // 测试用更短延迟
      healthCheckInterval: 500,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('初始状态', () => {
    it('初始状态应为 disconnected', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      expect(actor.getSnapshot().value).toBe(RadioState.DISCONNECTED);
      expect(isRadioState(actor, RadioState.DISCONNECTED)).toBe(true);

      actor.stop();
    });

    it('初始上下文应包含重连配置', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      const context = getRadioContext(actor);
      expect(context.reconnectAttempts).toBe(0);
      expect(context.maxReconnectAttempts).toBe(3);
      expect(context.isHealthy).toBe(false);

      actor.stop();
    });
  });

  describe('连接流程', () => {
    it('连接成功：disconnected → connecting → connected', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });

      // 等待 onConnect 被调用
      await vi.waitFor(() => {
        expect(mockInput.onConnect).toHaveBeenCalledWith(mockConfig);
      });

      // 等待转换到 connected 状态
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      expect(isRadioState(actor, RadioState.CONNECTED)).toBe(true);

      const context = getRadioContext(actor);
      expect(context.config).toEqual(mockConfig);
      expect(context.isHealthy).toBe(true);
      expect(context.connectedTimestamp).toBeDefined();

      actor.stop();
    });

    it('连接失败且无法重连：disconnected → connecting → error', async () => {
      const testError = new Error('连接失败');
      mockInput.onConnect = vi.fn().mockRejectedValue(testError);
      mockInput.maxReconnectAttempts = 0; // 不允许重连

      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });

      // 等待转换到 error 状态
      await waitForRadioState(actor, RadioState.ERROR, 1000);

      expect(isRadioState(actor, RadioState.ERROR)).toBe(true);
      expect(mockInput.onError).toHaveBeenCalledWith(testError);

      actor.stop();
    });

    it('首次连接失败应进入重连：disconnected → connecting → reconnecting', async () => {
      const testError = new Error('首次连接失败');
      mockInput.onConnect = vi.fn().mockRejectedValue(testError);

      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });

      // 等待转换到 reconnecting 状态
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      expect(isRadioState(actor, RadioState.RECONNECTING)).toBe(true);

      const context = getRadioContext(actor);
      expect(context.reconnectAttempts).toBe(1);

      actor.stop();
    });
  });

  describe('断开流程', () => {
    it('主动断开：connected → disconnected', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      // 先连接
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      // 断开
      actor.send({ type: 'DISCONNECT', reason: '用户主动断开' });
      await waitForRadioState(actor, RadioState.DISCONNECTED, 1000);

      expect(mockInput.onDisconnect).toHaveBeenCalledWith('用户主动断开');

      const context = getRadioContext(actor);
      expect(context.disconnectReason).toBe('用户主动断开');

      actor.stop();
    });

    it('连接丢失：connected → reconnecting', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      // 先连接
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      // 连接丢失
      actor.send({ type: 'CONNECTION_LOST', reason: '网络中断' });
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      const context = getRadioContext(actor);
      expect(context.reconnectAttempts).toBe(1);
      expect(context.disconnectReason).toBe('网络中断');

      actor.stop();
    });
  });

  describe('重连机制', () => {
    it('重连成功：reconnecting → connecting → connected', async () => {
      let failOnce = true;
      mockInput.onConnect = vi.fn().mockImplementation(() => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('首次失败'));
        }
        return Promise.resolve();
      });

      const actor = createRadioActor(mockInput);
      actor.start();

      // 首次连接失败
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      // 等待自动重连（延迟100ms）
      await waitForRadioState(actor, RadioState.CONNECTED, 2000);

      expect(isRadioState(actor, RadioState.CONNECTED)).toBe(true);

      const context = getRadioContext(actor);
      expect(context.reconnectAttempts).toBe(0); // 成功后重置

      actor.stop();
    });

    it('达到最大重连次数：reconnecting → ... → error', async () => {
      mockInput.onConnect = vi.fn().mockRejectedValue(new Error('持续失败'));
      mockInput.maxReconnectAttempts = 2;

      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });

      // 首次失败 → reconnecting (attempts=1)
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      // 第2次失败 → reconnecting (attempts=2)
      await vi.waitFor(
        () => {
          const context = getRadioContext(actor);
          return context.reconnectAttempts === 2;
        },
        { timeout: 2000 }
      );

      // 第3次失败 → error (达到最大次数)
      await waitForRadioState(actor, RadioState.ERROR, 2000);

      actor.stop();
    }, 10000); // 增加超时时间

    it('无限重连模式不应进入 error 状态', async () => {
      mockInput.onConnect = vi.fn().mockRejectedValue(new Error('持续失败'));
      mockInput.maxReconnectAttempts = -1; // 无限重连

      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });

      // 应该一直在 reconnecting/connecting 状态循环
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      // 等待一段时间，验证不会进入 error 状态
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(
        isRadioState(actor, [
          RadioState.RECONNECTING,
          RadioState.CONNECTING,
        ])
      ).toBe(true);

      actor.stop();
    });

    it('可以手动停止重连', async () => {
      mockInput.onConnect = vi.fn().mockRejectedValue(new Error('持续失败'));

      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      // 停止重连
      actor.send({ type: 'STOP_RECONNECTING' });
      await waitForRadioState(actor, RadioState.DISCONNECTED, 1000);

      actor.stop();
    });
  });

  describe('健康检查', () => {
    it('健康检查失败应进入重连', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      // 先连接
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.CONNECTED, 1000);

      // 健康检查失败
      actor.send({
        type: 'HEALTH_CHECK_FAILED',
        error: new Error('健康检查失败'),
      });
      await waitForRadioState(actor, RadioState.RECONNECTING, 1000);

      actor.stop();
    });
  });

  describe('错误状态', () => {
    it('从错误状态可以 RESET 回到 disconnected', async () => {
      mockInput.onConnect = vi.fn().mockRejectedValue(new Error('连接失败'));
      mockInput.maxReconnectAttempts = 0;

      const actor = createRadioActor(mockInput);
      actor.start();

      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.ERROR, 1000);

      // 重置
      actor.send({ type: 'RESET' });
      await waitForRadioState(actor, RadioState.DISCONNECTED, 1000);

      const context = getRadioContext(actor);
      expect(context.error).toBeUndefined();
      expect(context.reconnectAttempts).toBe(0);

      actor.stop();
    });

    it('从错误状态可以 RECONNECT 重新连接', async () => {
      let failOnce = true;
      mockInput.onConnect = vi.fn().mockImplementation(() => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('首次失败'));
        }
        return Promise.resolve();
      });
      mockInput.maxReconnectAttempts = 0;

      const actor = createRadioActor(mockInput);
      actor.start();

      // 首次连接失败 → error
      actor.send({ type: 'CONNECT', config: mockConfig });
      await waitForRadioState(actor, RadioState.ERROR, 1000);

      // 重新连接
      actor.send({ type: 'RECONNECT' });
      await waitForRadioState(actor, RadioState.CONNECTED, 2000);

      expect(isRadioState(actor, RadioState.CONNECTED)).toBe(true);

      actor.stop();
    });
  });

  describe('工具函数', () => {
    it('isRadioState 支持单个状态', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      expect(isRadioState(actor, RadioState.DISCONNECTED)).toBe(true);
      expect(isRadioState(actor, RadioState.CONNECTED)).toBe(false);

      actor.stop();
    });

    it('isRadioState 支持多个状态', () => {
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

    it('getRadioContext 返回当前上下文', () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      const context = getRadioContext(actor);
      expect(context).toBeDefined();
      expect(context.reconnectAttempts).toBe(0);
      expect(context.isHealthy).toBe(false);

      actor.stop();
    });

    it('waitForRadioState 超时应抛出错误', async () => {
      const actor = createRadioActor(mockInput);
      actor.start();

      await expect(
        waitForRadioState(actor, RadioState.CONNECTED, 100)
      ).rejects.toThrow('等待状态 connected 超时');

      actor.stop();
    });
  });
});
