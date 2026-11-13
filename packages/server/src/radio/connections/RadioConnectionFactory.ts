/* eslint-disable @typescript-eslint/no-explicit-any */
// RadioConnectionFactory - 工厂模式需要使用any

/**
 * RadioConnectionFactory - 电台连接工厂
 *
 * 根据配置类型创建相应的电台连接实例
 * 统一的创建接口，简化连接实例的创建
 */

import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import type { IRadioConnection, RadioConnectionConfig } from './IRadioConnection.js';
import { IcomWlanConnection } from './IcomWlanConnection.js';
import { TciConnection } from './TciConnection.js';
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

      case 'tci':
        logger.debug('Creating TCI connection instance');
        return new TciConnection();

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
            'Supported types: icom-wlan, tci, network, serial',
            'Check the connection type in the configuration file',
          ],
        });
    }
  }

}
