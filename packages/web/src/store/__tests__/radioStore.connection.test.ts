import { describe, expect, it } from 'vitest';
import { connectionReducer, initialConnectionState } from '../radioStore';

describe('radioStore connection reducer', () => {
  it('enters reconnecting state without clearing prior successful connection history', () => {
    const connectedState = connectionReducer(initialConnectionState, { type: 'connected' });

    const reconnectingState = connectionReducer(connectedState, { type: 'reconnecting' });

    expect(reconnectingState.isConnected).toBe(false);
    expect(reconnectingState.isConnecting).toBe(true);
    expect(reconnectingState.wasEverConnected).toBe(true);
    expect(reconnectingState.connectError).toBeNull();
  });

  it('treats a stable disconnect as disconnected instead of implicitly reconnecting', () => {
    const connectedState = connectionReducer(initialConnectionState, { type: 'connected' });

    const disconnectedState = connectionReducer(connectedState, { type: 'disconnected' });

    expect(disconnectedState.isConnected).toBe(false);
    expect(disconnectedState.isConnecting).toBe(false);
    expect(disconnectedState.wasEverConnected).toBe(true);
  });
});
