/**
 * engineStateMachine 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createEngineActor,
  isEngineState,
  getEngineContext,
  waitForEngineState,
} from '../engineStateMachine';
import { EngineState, type EngineInput } from '../types';

describe('engineStateMachine', () => {
  let mockInput: EngineInput;

  beforeEach(() => {
    // 创建mock input
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

  describe('初始状态', () => {
    it('初始状态应为 idle', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      expect(actor.getSnapshot().value).toBe(EngineState.IDLE);
      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);

      actor.stop();
    });

    it('初始上下文应包含空的 startedResources', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      const context = getEngineContext(actor);
      expect(context.startedResources).toEqual([]);
      expect(context.error).toBeUndefined();

      actor.stop();
    });
  });

  describe('启动流程', () => {
    it('启动成功：idle → starting → running', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // 发送 START 事件
      actor.send({ type: 'START' });

      // 等待 onStart 被调用
      await vi.waitFor(() => {
        expect(mockInput.onStart).toHaveBeenCalledOnce();
      });

      // 等待转换到 running 状态
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      expect(isEngineState(actor, EngineState.RUNNING)).toBe(true);

      actor.stop();
    });

    it('启动失败：idle → starting → error', async () => {
      const testError = new Error('启动失败');
      mockInput.onStart = vi.fn().mockRejectedValue(testError);

      const actor = createEngineActor(mockInput);
      actor.start();

      actor.send({ type: 'START' });

      // 等待转换到 error 状态
      await waitForEngineState(actor, EngineState.ERROR, 1000);

      expect(isEngineState(actor, EngineState.ERROR)).toBe(true);
      expect(mockInput.onError).toHaveBeenCalledWith(testError);

      const context = getEngineContext(actor);
      expect(context.error).toBeDefined();

      actor.stop();
    });

    it('启动时应记录 startTimestamp', async () => {
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

  describe('停止流程', () => {
    it('停止成功：running → stopping → idle', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // 先启动
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // 再停止
      actor.send({ type: 'STOP' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);
      expect(mockInput.onStop).toHaveBeenCalledOnce();

      actor.stop();
    });

    it('停止失败：running → stopping → error', async () => {
      const testError = new Error('停止失败');
      mockInput.onStop = vi.fn().mockRejectedValue(testError);

      const actor = createEngineActor(mockInput);
      actor.start();

      // 先启动
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // 再停止（失败）
      actor.send({ type: 'STOP' });
      await waitForEngineState(actor, EngineState.ERROR, 1000);

      expect(isEngineState(actor, EngineState.ERROR)).toBe(true);
      expect(mockInput.onError).toHaveBeenCalledWith(testError);

      actor.stop();
    });

    it('停止时应记录 stopTimestamp', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // 先启动
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // 再停止
      actor.send({ type: 'STOP' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      const context = getEngineContext(actor);
      expect(context.stopTimestamp).toBeDefined();
      expect(context.stopTimestamp).toBeGreaterThanOrEqual(context.startTimestamp || 0);

      actor.stop();
    });
  });

  describe('强制停止', () => {
    it('FORCE_STOP 事件应触发停止', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // 先启动
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // 强制停止
      actor.send({ type: 'FORCE_STOP', reason: '测试强制停止' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      const context = getEngineContext(actor);
      expect(context.forcedStop).toBe(true);

      actor.stop();
    });

    it('RADIO_DISCONNECTED 事件应触发停止', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // 先启动
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // 电台断开
      actor.send({ type: 'RADIO_DISCONNECTED', reason: '电台连接丢失' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      const context = getEngineContext(actor);
      expect(context.forcedStop).toBe(true);

      actor.stop();
    });

    it('启动中也可以被强制停止', async () => {
      // 模拟慢启动
      mockInput.onStart = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      );

      const actor = createEngineActor(mockInput);
      actor.start();

      actor.send({ type: 'START' });

      // 等待进入 starting 状态
      await vi.waitFor(() => {
        expect(isEngineState(actor, EngineState.STARTING)).toBe(true);
      });

      // 在启动中强制停止
      actor.send({ type: 'FORCE_STOP', reason: '用户取消启动' });

      // 应该转到 stopping 状态
      await waitForEngineState(actor, EngineState.STOPPING, 1000);

      actor.stop();
    });
  });

  describe('错误状态', () => {
    it('从错误状态可以 RESET 回到 idle', async () => {
      const testError = new Error('启动失败');
      mockInput.onStart = vi.fn().mockRejectedValue(testError);

      const actor = createEngineActor(mockInput);
      actor.start();

      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.ERROR, 1000);

      // 重置
      actor.send({ type: 'RESET' });
      await waitForEngineState(actor, EngineState.IDLE, 1000);

      const context = getEngineContext(actor);
      expect(context.error).toBeUndefined();

      actor.stop();
    });

    it('从错误状态可以 RETRY 重新启动', async () => {
      let failOnce = true;
      mockInput.onStart = vi.fn().mockImplementation(() => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('首次失败'));
        }
        return Promise.resolve();
      });

      const actor = createEngineActor(mockInput);
      actor.start();

      // 首次启动失败
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.ERROR, 1000);

      // 重试
      actor.send({ type: 'RETRY' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      expect(isEngineState(actor, EngineState.RUNNING)).toBe(true);

      actor.stop();
    });

    it('错误状态下调用 onError 回调', async () => {
      const testError = new Error('测试错误');
      mockInput.onStart = vi.fn().mockRejectedValue(testError);

      const actor = createEngineActor(mockInput);
      actor.start();

      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.ERROR, 1000);

      expect(mockInput.onError).toHaveBeenCalledWith(testError);

      actor.stop();
    });
  });

  describe('状态变化回调', () => {
    it('每次状态变化都应调用 onStateChange', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      // idle → starting
      actor.send({ type: 'START' });
      await waitForEngineState(actor, EngineState.RUNNING, 1000);

      // 验证状态变化回调被调用
      // idle (初始进入) + starting (entry) + running (entry) = 至少3次
      expect(mockInput.onStateChange).toHaveBeenCalled();

      actor.stop();
    });
  });

  describe('工具函数', () => {
    it('isEngineState 支持单个状态', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      expect(isEngineState(actor, EngineState.IDLE)).toBe(true);
      expect(isEngineState(actor, EngineState.RUNNING)).toBe(false);

      actor.stop();
    });

    it('isEngineState 支持多个状态', () => {
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

    it('getEngineContext 返回当前上下文', () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      const context = getEngineContext(actor);
      expect(context).toBeDefined();
      expect(context.startedResources).toEqual([]);

      actor.stop();
    });

    it('waitForEngineState 超时应抛出错误', async () => {
      const actor = createEngineActor(mockInput);
      actor.start();

      await expect(
        waitForEngineState(actor, EngineState.RUNNING, 100)
      ).rejects.toThrow('等待状态 running 超时');

      actor.stop();
    });
  });
});
