import { describe, expect, it } from 'vitest';
import { getRadioServiceBootstrapAction } from '../radio/bootstrap';
import { connectionReducer, initialConnectionState, initialRadioState, radioReducer } from '../radioStore';
import type { BootstrapStatus, SystemStatus } from '@tx5dr/contracts';

describe('radioStore connection reducer', () => {
  it('enters reconnecting state without clearing prior successful connection history', () => {
    const connectedState = connectionReducer(initialConnectionState, { type: 'connected' });

    const reconnectingState = connectionReducer(connectedState, { type: 'reconnecting' });

    expect(reconnectingState.isConnected).toBe(false);
    expect(reconnectingState.isConnecting).toBe(true);
    expect(reconnectingState.isReady).toBe(false);
    expect(reconnectingState.wasEverConnected).toBe(true);
    expect(reconnectingState.connectError).toBeNull();
  });

  it('marks the connection ready only after server handshake completes', () => {
    const connectedState = connectionReducer(initialConnectionState, { type: 'connected' });
    expect(connectedState.isConnected).toBe(true);
    expect(connectedState.isReady).toBe(false);

    const readyState = connectionReducer(connectedState, { type: 'handshakeComplete' });
    expect(readyState.isConnected).toBe(true);
    expect(readyState.isReady).toBe(true);
  });

  it('treats a stable disconnect as disconnected instead of implicitly reconnecting', () => {
    const connectedState = connectionReducer(
      connectionReducer(initialConnectionState, { type: 'connected' }),
      { type: 'handshakeComplete' },
    );

    const disconnectedState = connectionReducer(connectedState, { type: 'disconnected' });

    expect(disconnectedState.isConnected).toBe(false);
    expect(disconnectedState.isConnecting).toBe(false);
    expect(disconnectedState.isReady).toBe(false);
    expect(disconnectedState.wasEverConnected).toBe(true);
  });

  it('force reconnects when reusing an already open singleton service', () => {
    expect(getRadioServiceBootstrapAction({ isConnected: true, isConnecting: false })).toBe('forceReconnect');
  });

  it('force reconnects when reusing a connecting singleton service', () => {
    expect(getRadioServiceBootstrapAction({ isConnected: false, isConnecting: true })).toBe('forceReconnect');
  });

  it('connects when bootstrapping an idle singleton service', () => {
    expect(getRadioServiceBootstrapAction({ isConnected: false, isConnecting: false })).toBe('connect');
  });

  it('keeps completed bootstrap hidden when runtime engine state later becomes idle', () => {
    const completedBootstrap: BootstrapStatus = {
      bootSessionId: 'boot-test',
      lifecycle: 'completed',
      startedAt: 1,
      updatedAt: 2,
      completedAt: 2,
      durationMs: 1,
      blockingReady: false,
      phases: [],
      summary: {
        total: 0,
        pending: 0,
        running: 0,
        ready: 0,
        skipped: 0,
        warning: 0,
        failed: 0,
        timedOut: 0,
      },
    };
    const withBootstrap = radioReducer(initialRadioState, {
      type: 'bootstrapStatusChanged',
      payload: completedBootstrap,
    });

    const afterRuntimeIdle = radioReducer(withBootstrap, {
      type: 'systemStatus',
      payload: {
        isRunning: false,
        isDecoding: false,
        currentMode: null,
        currentTime: 0,
        nextSlotIn: 0,
        audioStarted: false,
        engineMode: 'digital',
        engineState: 'idle',
      } as unknown as SystemStatus,
    });

    expect(afterRuntimeIdle.bootstrapStatus?.lifecycle).toBe('completed');
  });
});
