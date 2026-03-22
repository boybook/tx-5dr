/* eslint-disable @typescript-eslint/no-explicit-any */
// RadioConnectionFactory - 工厂模式需要使用any

/**
 * RadioConnectionFactory - 电台连接工厂
 *
 * 根据配置类型创建相应的电台连接实例
 * 统一的创建接口，简化连接实例的创建
 */

import type { HamlibConfig } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import type { IRadioConnection, RadioConnectionConfig } from './IRadioConnection.js';
import { IcomWlanConnection } from './IcomWlanConnection.js';
import { HamlibConnection } from './HamlibConnection.js';
import { NullConnection } from './NullConnection.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('RadioConnectionFactory');

/**
 * 电台连接工厂类
 */
export class RadioConnectionFactory {
  /**
   * 根据配置创建电台连接实例
   *
   * @param config - 电台连接配置
   * @returns 电台连接实例
   * @throws {RadioError} 配置无效或类型不支持时抛出
   */
  static create(config: RadioConnectionConfig): IRadioConnection {
    // 验证配置
    if (!config || !config.type) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Invalid configuration: missing type field',
        userMessage: 'Invalid radio configuration',
        suggestions: ['Please provide a valid radio configuration'],
      });
    }

    // 根据类型创建相应的连接实例
    switch (config.type) {
      case 'icom-wlan':
        logger.debug('Creating ICOM WLAN connection instance');
        return new IcomWlanConnection();

      case 'network':
      case 'serial':
        logger.debug(`Creating Hamlib connection instance (${config.type})`);
        return new HamlibConnection();

      case 'none':
        logger.debug('Creating NullConnection instance (no-radio mode)');
        return new NullConnection();

      default:
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `Unsupported connection type: ${(config as any).type}`,
          userMessage: 'Unsupported radio connection type',
          suggestions: [
            'Supported types: icom-wlan, network, serial',
            'Check the connection type in the configuration file',
          ],
        });
    }
  }

  /**
   * 创建 ICOM WLAN 连接实例
   *
   * @param config - ICOM WLAN 配置
   * @returns ICOM WLAN 连接实例
   */
  static createIcomWlan(config: RadioConnectionConfig): IRadioConnection {
    if (config.type !== 'icom-wlan') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Configuration type error: expected 'icom-wlan', got '${config.type}'`,
        userMessage: 'Configuration type mismatch',
        suggestions: ['Please use an ICOM WLAN type configuration'],
      });
    }

    logger.debug('Creating ICOM WLAN connection instance');
    return new IcomWlanConnection();
  }

  /**
   * 创建 Hamlib 连接实例
   *
   * @param config - Hamlib 配置 (network 或 serial)
   * @returns Hamlib 连接实例
   */
  static createHamlib(config: RadioConnectionConfig): IRadioConnection {
    if (config.type !== 'network' && config.type !== 'serial') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Configuration type error: expected 'network' or 'serial', got '${config.type}'`,
        userMessage: 'Configuration type mismatch',
        suggestions: ['Please use a Hamlib type configuration (network or serial)'],
      });
    }

    logger.debug(`Creating Hamlib connection instance (${config.type})`);
    return new HamlibConnection();
  }

  /**
   * 验证配置是否有效
   *
   * @param config - 电台连接配置
   * @returns 验证结果
   */
  static validateConfig(config: RadioConnectionConfig): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // 检查 type 字段
    if (!config || !config.type) {
      errors.push('Missing type field');
      return { valid: false, errors };
    }

    // 根据类型验证必需字段
    switch (config.type) {
      case 'icom-wlan':
        if (!config.icomWlan) errors.push('ICOM WLAN configuration missing icomWlan object');
        else {
          if (!config.icomWlan.ip) errors.push('ICOM WLAN configuration missing required field: icomWlan.ip');
          if (!config.icomWlan.port) errors.push('ICOM WLAN configuration missing required field: icomWlan.port');
        }
        break;

      case 'network':
        if (!config.network) errors.push('Network configuration missing network object');
        else {
          if (!config.network.host) errors.push('Network configuration missing required field: network.host');
          if (!config.network.port) errors.push('Network configuration missing required field: network.port');
        }
        break;

      case 'serial':
        if (!config.serial) errors.push('Serial configuration missing serial object');
        else {
          if (!config.serial.path) errors.push('Serial configuration missing required field: serial.path');
          if (!config.serial.rigModel) errors.push('Serial configuration missing required field: serial.rigModel');
        }
        break;

      case 'none':
        // none 类型不需要额外字段
        break;

      default:
        errors.push(`Unsupported connection type: ${(config as any).type}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
