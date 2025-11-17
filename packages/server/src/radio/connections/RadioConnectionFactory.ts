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
        message: '配置无效: 缺少 type 字段',
        userMessage: '电台配置无效',
        suggestions: ['请提供有效的电台配置'],
      });
    }

    // 根据类型创建相应的连接实例
    switch (config.type) {
      case 'icom-wlan':
        console.log('🏭 [RadioConnectionFactory] 创建 ICOM WLAN 连接实例');
        return new IcomWlanConnection();

      case 'network':
      case 'serial':
        console.log(`🏭 [RadioConnectionFactory] 创建 Hamlib 连接实例 (${config.type})`);
        return new HamlibConnection();

      case 'none':
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: '连接类型为 none，无法创建连接实例',
          userMessage: '未配置电台连接',
          suggestions: ['请在配置中选择电台连接类型'],
        });

      default:
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `不支持的连接类型: ${(config as any).type}`,
          userMessage: '不支持的电台连接类型',
          suggestions: [
            '支持的类型: icom-wlan, network, serial',
            '请检查配置文件中的连接类型',
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
        message: `配置类型错误: 期望 'icom-wlan'，实际 '${config.type}'`,
        userMessage: '配置类型不匹配',
        suggestions: ['请使用 ICOM WLAN 类型的配置'],
      });
    }

    console.log('🏭 [RadioConnectionFactory] 创建 ICOM WLAN 连接实例');
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
        message: `配置类型错误: 期望 'network' 或 'serial'，实际 '${config.type}'`,
        userMessage: '配置类型不匹配',
        suggestions: ['请使用 Hamlib 类型的配置 (network 或 serial)'],
      });
    }

    console.log(`🏭 [RadioConnectionFactory] 创建 Hamlib 连接实例 (${config.type})`);
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
      errors.push('缺少 type 字段');
      return { valid: false, errors };
    }

    // 根据类型验证必需字段
    switch (config.type) {
      case 'icom-wlan':
        if (!config.icomWlan) errors.push('ICOM WLAN 配置缺少 icomWlan 对象');
        else {
          if (!config.icomWlan.ip) errors.push('ICOM WLAN 配置缺少 icomWlan.ip 字段');
          if (!config.icomWlan.port) errors.push('ICOM WLAN 配置缺少 icomWlan.port 字段');
        }
        break;

      case 'network':
        if (!config.network) errors.push('网络配置缺少 network 对象');
        else {
          if (!config.network.host) errors.push('网络配置缺少 network.host 字段');
          if (!config.network.port) errors.push('网络配置缺少 network.port 字段');
        }
        break;

      case 'serial':
        if (!config.serial) errors.push('串口配置缺少 serial 对象');
        else {
          if (!config.serial.path) errors.push('串口配置缺少 serial.path 字段');
          if (!config.serial.rigModel) errors.push('串口配置缺少 serial.rigModel 字段');
        }
        break;

      case 'none':
        // none 类型不需要额外字段
        break;

      default:
        errors.push(`不支持的连接类型: ${(config as any).type}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
