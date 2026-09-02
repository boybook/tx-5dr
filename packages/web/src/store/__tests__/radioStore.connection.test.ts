import { describe, expect, it } from 'vitest';
import { getRadioServiceBootstrapAction } from '../radio/bootstrap';
import { connectionReducer, initialConnectionState, initialRadioState, radioReducer } from '../radioStore';
import type { BootstrapStatus, SystemStatus } from '@tx5dr/contracts';
import { shouldShowServerStatusPage } from '../radio/connectionView';

describe('radioStore connection reducer', () => {
  it('keeps the latest physical operating-state snapshot and ignores stale revisions', () => {
    const confirmed = radioReducer(initialRadioState, {
      type: 'frequencyStateChanged',
      payload: {
        frequency: 14_080_000,
        mode: 'FT4',
        band: '20m',
        description: '14.080 MHz',
        radioConnected: true,
        revision: 2,
        connectionGeneration: 3,
        confirmation: 'confirmed',
        observedFrequency: 14_080_000,
      },
    });

    const stale = radioReducer(confirmed, {
      type: 'frequencyStateChanged',
      payload: {
        frequency: 14_074_000,
        mode: 'FT8',
        band: '20m',
        description: '14.074 MHz',
        radioConnected: true,
        revision: 1,
        connectionGeneration: 3,
        confirmation: 'confirmed',
        observedFrequency: 14_074_000,
      },
    });

    expect(confirmed.currentRadioFrequency).toBe(14_080_000);
    expect(stale).toBe(confirmed);
  });

  it('ignores snapshots from an older CAT connection generation', () => {
    const current = radioReducer(initialRadioState, {
      type: 'frequencyStateChanged',
      payload: {
        frequency: 14_080_000,
        mode: 'FT4',
        band: '20m',
        description: '14.080 MHz',
        radioConnected: true,
        revision: 4,
        connectionGeneration: 3,
        confirmation: 'confirmed',
        observedFrequency: 14_080_000,
      },
    });

    const stale = radioReducer(current, {
      type: 'frequencyStateChanged',
      payload: {
        frequency: 14_074_000,
        mode: 'FT8',
        band: '20m',
        description: '14.074 MHz',
        radioConnected: true,
        revision: 5,
        connectionGeneration: 2,
        confirmation: 'confirmed',
        observedFrequency: 14_074_000,
      },
    });

    expect(stale).toBe(current);
  });

  it('enters reconnecting state without clearing prior successful connection history', () => {
    const connectedState = connectionReducer(initialConnectionState, { type: 'connected' });

    const reconnectingState = connectionReducer(connectedState, { type: 'reconnecting' });

    expect(reconnectingState.isConnected).toBe(false);
    expect(reconnectingState.isConnecting).toBe(true);
    expect(reconnectingState.isReady).toBe(false);
    expect(reconnectingState.wasEverConnected).toBe(true);
    expect(reconnectingState.wasEverReady).toBe(false);
    expect(reconnectingState.connectError).toBeNull();
  });

  it('marks the connection usable only after server handshake completes', () => {
    const connectedState = connectionReducer(initialConnectionState, { type: 'connected' });
    expect(connectedState.isConnected).toBe(false);
    expect(connectedState.isConnecting).toBe(true);
    expect(connectedState.isReady).toBe(false);

    const readyState = connectionReducer(connectedState, { type: 'handshakeComplete' });
    expect(readyState.isConnected).toBe(true);
    expect(readyState.isConnecting).toBe(false);
    expect(readyState.isReady).toBe(true);
    expect(readyState.wasEverReady).toBe(true);
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
    expect(disconnectedState.wasEverReady).toBe(true);
  });

  it('preserves an admission denial when the socket subsequently reports disconnected', () => {
    const denial = {
      reason: 'capacity_reached' as const,
      current: 32,
      limit: 32,
      retryAfterMs: 15_000,
    };
    const deniedState = connectionReducer(initialConnectionState, {
      type: 'disconnected',
      payload: denial,
    });

    const finalState = connectionReducer(deniedState, { type: 'disconnected' });

    expect(finalState.accessDenied).toEqual(denial);
  });

  it('shows the capacity page even after the client was previously ready', () => {
    const readyState = connectionReducer(
      connectionReducer(initialConnectionState, { type: 'connected' }),
      { type: 'handshakeComplete' },
    );
    const deniedState = connectionReducer(readyState, {
      type: 'disconnected',
      payload: {
        reason: 'ip_limit_reached',
        current: 16,
        limit: 16,
        retryAfterMs: 15_000,
      },
    });

    expect(readyState.wasEverReady).toBe(true);
    expect(shouldShowServerStatusPage(deniedState)).toBe(true);
  });

  it('shows origin recovery even after the client was previously ready', () => {
    const readyState = connectionReducer(
      connectionReducer(initialConnectionState, { type: 'connected' }),
      { type: 'handshakeComplete' },
    );
    const deniedState = connectionReducer(readyState, {
      type: 'disconnected',
      payload: { reason: 'origin_not_allowed' },
    });

    expect(shouldShowServerStatusPage(deniedState)).toBe(true);
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
