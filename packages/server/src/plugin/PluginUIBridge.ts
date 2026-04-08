import type { UIBridge } from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginUIBridge');

/**
 * 插件 UI 数据桥接
 * ctx.ui.send() 将数据通过引擎事件发出，经 WSServer 广播到前端
 */
export class PluginUIBridge implements UIBridge {
  constructor(
    private pluginName: string,
    private operatorId: string,
    private eventEmitter: EventEmitter<DigitalRadioEngineEvents>,
  ) {}

  send(panelId: string, data: unknown): void {
    logger.debug(`Plugin UI data: plugin=${this.pluginName}, panel=${panelId}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.eventEmitter as any).emit('pluginData', {
      pluginName: this.pluginName,
      operatorId: this.operatorId,
      panelId,
      data,
    });
  }
}
