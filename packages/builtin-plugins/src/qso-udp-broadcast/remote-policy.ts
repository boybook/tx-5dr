import type { PluginContext } from '@tx5dr/plugin-api';
import type { WsjtMessage } from './wsjtx-types.js';

export interface RemotePolicySettings {
  allowReplyRequests: boolean;
  allowHaltTxRequests: boolean;
  allowFreeTextRequests: boolean;
  allowLocationRequests: boolean;
  allowConfigureRequests: boolean;
  allowCloseRequests: boolean;
  allowSwitchConfigurationRequests: boolean;
}

export function isRemoteMessageAllowed(message: WsjtMessage, settings: RemotePolicySettings): boolean {
  switch (message.kind) {
    case 'reply': return settings.allowReplyRequests;
    case 'halt-tx': return settings.allowHaltTxRequests;
    case 'free-text': return settings.allowFreeTextRequests;
    case 'location': return settings.allowLocationRequests;
    case 'configure': return settings.allowConfigureRequests;
    case 'close': return settings.allowCloseRequests;
    case 'switch-configuration': return settings.allowSwitchConfigurationRequests;
    case 'heartbeat':
    case 'clear':
    case 'replay':
    case 'highlight-callsign':
    case 'annotation-info':
      return true;
    default:
      return false;
  }
}

export function logRemoteDenied(ctx: PluginContext, message: WsjtMessage): void {
  ctx.log.warn('WSJT-X UDP remote request denied by policy', {
    kind: message.kind,
    id: message.id,
    type: message.type,
  });
}
