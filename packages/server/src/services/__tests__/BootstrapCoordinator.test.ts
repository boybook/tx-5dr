import { describe, expect, it, afterEach, vi } from 'vitest';
import { BootstrapCoordinator } from '../BootstrapCoordinator.js';
import type { BootstrapPhaseId } from '@tx5dr/contracts';

const phaseIds: BootstrapPhaseId[] = [
  'config-auth',
  'core-http',
  'engine-bootstrap',
  'audio-device-discovery',
  'logbook-prewarm',
  'plugin-bootstrap',
  'ntp-initial-check',
  'active-profile-autostart',
];

function freshCoordinator(): BootstrapCoordinator {
  const existing = BootstrapCoordinator.getInstance();
  existing.resetForTests();
  return BootstrapCoordinator.getInstance();
}

describe('BootstrapCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    BootstrapCoordinator.getInstance().resetForTests();
  });

  it('marks lifecycle completed when all phases are ready or skipped', () => {
    const coordinator = freshCoordinator();

    for (const id of phaseIds) {
      if (id === 'active-profile-autostart') {
        coordinator.skipPhase(id, 'no profile');
      } else {
        coordinator.startPhase(id);
        coordinator.completePhase(id);
      }
    }

    const status = coordinator.getStatus();
    expect(status.lifecycle).toBe('completed');
    expect(status.completedAt).toBeTypeOf('number');
    expect(status.summary.ready).toBe(7);
    expect(status.summary.skipped).toBe(1);
  });

  it('does not regress completed bootstrap after runtime-like updates', () => {
    const coordinator = freshCoordinator();
    for (const id of phaseIds) {
      coordinator.completePhase(id);
    }

    expect(coordinator.getStatus().lifecycle).toBe('completed');
    coordinator.failPhase('active-profile-autostart', 'manual stop should not affect bootstrap');

    const status = coordinator.getStatus();
    expect(status.lifecycle).toBe('completed');
    expect(status.phases.find(phase => phase.id === 'active-profile-autostart')?.state).toBe('ready');
  });

  it('surfaces timeout as degraded and can recover to completed when phase finishes', async () => {
    vi.useFakeTimers();
    const coordinator = freshCoordinator();
    for (const id of phaseIds.filter(id => id !== 'logbook-prewarm')) {
      coordinator.completePhase(id);
    }

    const task = coordinator.runPhase(
      'logbook-prewarm',
      async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      },
      { timeoutMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(60);
    expect(coordinator.getStatus().lifecycle).toBe('degraded');
    expect(coordinator.getStatus().phases.find(phase => phase.id === 'logbook-prewarm')?.state).toBe('timed_out');

    await vi.advanceTimersByTimeAsync(60);
    await task;

    expect(coordinator.getStatus().lifecycle).toBe('completed');
    expect(coordinator.getStatus().phases.find(phase => phase.id === 'logbook-prewarm')?.state).toBe('ready');
  });

  it('clears terminal completion time while a failed phase is retried', () => {
    const coordinator = freshCoordinator();
    for (const id of phaseIds) {
      if (id === 'plugin-bootstrap') {
        coordinator.failPhase(id, 'load failed');
      } else {
        coordinator.completePhase(id);
      }
    }

    expect(coordinator.getStatus().lifecycle).toBe('failed');
    expect(coordinator.getStatus().completedAt).toBeTypeOf('number');

    coordinator.startPhase('plugin-bootstrap', 'retrying');

    const retryingStatus = coordinator.getStatus();
    expect(retryingStatus.lifecycle).toBe('booting');
    expect(retryingStatus.completedAt).toBeUndefined();

    coordinator.completePhase('plugin-bootstrap');
    expect(coordinator.getStatus().lifecycle).toBe('completed');
  });
});
