export type RadioServiceBootstrapAction = 'connect' | 'forceReconnect';

export interface RadioServiceBootstrapConnectionInfo {
  isConnected: boolean;
  isConnecting: boolean;
}

export function getRadioServiceBootstrapAction(
  connectionInfo: RadioServiceBootstrapConnectionInfo,
): RadioServiceBootstrapAction {
  return connectionInfo.isConnected || connectionInfo.isConnecting
    ? 'forceReconnect'
    : 'connect';
}
