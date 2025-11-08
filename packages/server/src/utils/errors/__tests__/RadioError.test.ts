/**
 * RadioError 单元测试
 */

import { describe, it, expect } from 'vitest';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../RadioError';

describe('RadioError', () => {
  describe('构造函数', () => {
    it('创建基本错误', () => {
      const error = new RadioError({
        code: RadioErrorCode.CONNECTION_FAILED,
        message: 'Test error',
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RadioError);
      expect(error.name).toBe('RadioError');
      expect(error.code).toBe(RadioErrorCode.CONNECTION_FAILED);
      expect(error.message).toBe('Test error');
      expect(error.severity).toBe(RadioErrorSeverity.ERROR);
      expect(error.timestamp).toBeGreaterThan(0);
    });

    it('设置用户消息', () => {
      const error = new RadioError({
        code: RadioErrorCode.DEVICE_NOT_FOUND,
        message: 'Internal: Device eth0 not found',
        userMessage: '未找到网络设备',
      });

      expect(error.message).toBe('Internal: Device eth0 not found');
      expect(error.userMessage).toBe('未找到网络设备');
    });

    it('设置错误级别', () => {
      const error = new RadioError({
        code: RadioErrorCode.RECONNECT_MAX_ATTEMPTS,
        message: 'Max attempts reached',
        severity: RadioErrorSeverity.CRITICAL,
      });

      expect(error.severity).toBe(RadioErrorSeverity.CRITICAL);
    });

    it('设置建议', () => {
      const error = new RadioError({
        code: RadioErrorCode.CONNECTION_FAILED,
        message: 'Failed to connect',
        suggestions: ['Check network', 'Restart device'],
      });

      expect(error.suggestions).toEqual(['Check network', 'Restart device']);
    });

    it('设置原始错误', () => {
      const cause = new Error('Original error');
      const error = new RadioError({
        code: RadioErrorCode.NETWORK_ERROR,
        message: 'Network failed',
        cause,
      });

      expect(error.cause).toBe(cause);
    });

    it('设置上下文', () => {
      const error = new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: 'Invalid state',
        context: {
          currentState: 'running',
          expectedState: 'idle',
        },
      });

      expect(error.context).toEqual({
        currentState: 'running',
        expectedState: 'idle',
      });
    });
  });

  describe('from - 错误转换', () => {
    it('转换 RadioError 返回自身', () => {
      const original = new RadioError({
        code: RadioErrorCode.CONNECTION_FAILED,
        message: 'Test',
      });

      const converted = RadioError.from(original);
      expect(converted).toBe(original);
    });

    it('转换标准 Error', () => {
      const original = new Error('Test error');
      const converted = RadioError.from(original, RadioErrorCode.NETWORK_ERROR);

      expect(converted).toBeInstanceOf(RadioError);
      expect(converted.code).toBe(RadioErrorCode.NETWORK_ERROR);
      expect(converted.message).toBe('Test error');
      expect(converted.cause).toBe(original);
    });

    it('转换字符串', () => {
      const converted = RadioError.from('String error');

      expect(converted).toBeInstanceOf(RadioError);
      expect(converted.code).toBe(RadioErrorCode.UNKNOWN_ERROR);
      expect(converted.message).toBe('String error');
    });

    it('转换其他类型', () => {
      const converted = RadioError.from({ foo: 'bar' });

      expect(converted).toBeInstanceOf(RadioError);
      expect(converted.message).toBe('[object Object]');
    });
  });

  describe('工厂方法', () => {
    it('connectionFailed', () => {
      const error = RadioError.connectionFailed('Timeout');

      expect(error.code).toBe(RadioErrorCode.CONNECTION_FAILED);
      expect(error.message).toContain('Timeout');
      expect(error.userMessage).toBe('无法连接到电台');
      expect(error.suggestions.length).toBeGreaterThan(0);
    });

    it('deviceNotFound', () => {
      const error = RadioError.deviceNotFound('AudioDevice1');

      expect(error.code).toBe(RadioErrorCode.DEVICE_NOT_FOUND);
      expect(error.message).toContain('AudioDevice1');
      expect(error.userMessage).toContain('AudioDevice1');
      expect(error.context?.deviceName).toBe('AudioDevice1');
    });

    it('invalidState', () => {
      const error = RadioError.invalidState('start', 'running', 'idle');

      expect(error.code).toBe(RadioErrorCode.INVALID_STATE);
      expect(error.context?.operation).toBe('start');
      expect(error.context?.currentState).toBe('running');
      expect(error.context?.expectedState).toBe('idle');
    });

    it('reconnectMaxAttempts', () => {
      const error = RadioError.reconnectMaxAttempts(10);

      expect(error.code).toBe(RadioErrorCode.RECONNECT_MAX_ATTEMPTS);
      expect(error.severity).toBe(RadioErrorSeverity.CRITICAL);
      expect(error.context?.maxAttempts).toBe(10);
    });

    it('audioDeviceError', () => {
      const cause = new Error('Device busy');
      const error = RadioError.audioDeviceError('Failed to open', cause);

      expect(error.code).toBe(RadioErrorCode.AUDIO_DEVICE_ERROR);
      expect(error.message).toContain('Failed to open');
      expect(error.cause).toBe(cause);
    });

    it('pttActivationFailed', () => {
      const error = RadioError.pttActivationFailed('Not connected');

      expect(error.code).toBe(RadioErrorCode.PTT_ACTIVATION_FAILED);
      expect(error.message).toContain('Not connected');
    });
  });

  describe('序列化', () => {
    it('toJSON', () => {
      const cause = new Error('Cause error');
      const error = new RadioError({
        code: RadioErrorCode.CONNECTION_FAILED,
        message: 'Test error',
        userMessage: '连接失败',
        severity: RadioErrorSeverity.ERROR,
        suggestions: ['建议1', '建议2'],
        context: { foo: 'bar' },
        cause,
      });

      const json = error.toJSON();

      expect(json.name).toBe('RadioError');
      expect(json.code).toBe(RadioErrorCode.CONNECTION_FAILED);
      expect(json.message).toBe('Test error');
      expect(json.userMessage).toBe('连接失败');
      expect(json.severity).toBe(RadioErrorSeverity.ERROR);
      expect(json.suggestions).toEqual(['建议1', '建议2']);
      expect(json.context).toEqual({ foo: 'bar' });
      expect(json.timestamp).toBeGreaterThan(0);
      expect((json.cause as any).message).toBe('Cause error');
    });

    it('toString', () => {
      const error = new RadioError({
        code: RadioErrorCode.DEVICE_NOT_FOUND,
        message: 'Device not found',
      });

      expect(error.toString()).toBe('[DEVICE_NOT_FOUND] Device not found');
    });
  });
});
