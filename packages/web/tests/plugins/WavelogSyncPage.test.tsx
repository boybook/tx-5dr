// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../builtin-plugins/src/wavelog-sync/ui/sync/App';
const paused = { operationId: 'manual', revision: 1, operation: 'download', state: 'paused', stage: 'downloading',
  startedAt: 1, updatedAt: 2, processed: 1000, downloaded: 1000, imported: 1000, updated: 0,
  uploaded: 0, skipped: 0, failed: 0, conflicts: 0, rejected: 0, resumable: true, errors: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function bridge(invoke: (action: string, data?: unknown) => Promise<unknown>, params: Record<string, string> = {}) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(window, 'tx5dr', { configurable: true, value: { locale: 'en', ready: Promise.resolve(), params: { callsign: 'BG5DRB', ...params }, requestClose: vi.fn(),
    onLocaleChange: () => () => {}, resize() {}, invoke } });
}
describe('Wavelog sync page', () => {
  it('reveals automatic failure details while preserving a completed manual result', async () => {
    const invoke = vi.fn(async (action: string) => action === 'getAutomaticUploadStatus'
      ? { ...paused, trigger: 'auto', state: 'failed', failed: 1, resumable: false, errors: [{ code: 'remote_failed', message: 'Automatic upload needs reconciliation' }] }
      : { ...paused, trigger: 'manual', state: 'completed', resumable: false, stage: 'finished' });
    bridge(invoke); render(<App />);
    await screen.findByText('Automatic upload needs reconciliation');
    expect(screen.getByText('Completed · Finished')).toBeTruthy();
    expect(invoke.mock.calls.some(([action]) => action === 'beginSync')).toBe(false);
  });

  it('starts a parameterized upload once after ready without another selection', async () => {
    const completed = { ...paused, operation: 'upload', state: 'completed', resumable: false, stage: 'finished' };
    const invoke = vi.fn(async (action: string) => action === 'beginSync' ? { status: completed, step: 3 } : null);
    bridge(invoke, { intent: 'start', operation: 'upload', launchId: 'click-one' });
    const page = render(<App />);
    await screen.findByText('Completed · Finished');
    page.rerender(<App />);
    expect(invoke.mock.calls.filter(([action]) => action === 'beginSync')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('beginSync', { operation: 'upload', launchId: 'click-one' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });
  it('does not replace a different paused operation', async () => {
    const invoke = vi.fn(async (_action: string) => paused);
    bridge(invoke, { intent: 'start', operation: 'upload', launchId: 'click-two' }); render(<App />);
    await screen.findByText('Another operation is paused. Continue that operation first.');
    expect(invoke.mock.calls.every(([action]) => ['getSyncStatus', 'getAutomaticUploadStatus'].includes(action))).toBe(true);
  });
  it('allows explicit reconciliation to repair an unavailable checkpoint', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (['getSyncStatus', 'getAutomaticUploadStatus'].includes(action)) throw new Error('invalid checkpoint');
      return { status: { ...paused, operation: 'reconcile', state: 'completed', resumable: false, stage: 'finished' }, step: 1 };
    });
    bridge(invoke, { intent: 'start', operation: 'reconcile', launchId: 'repair' }); render(<App />);
    await screen.findByText('Completed · Finished');
    expect(invoke).toHaveBeenCalledWith('beginSync', { operation: 'reconcile', launchId: 'repair' });
  });
  it('shows a resumable result without starting or advancing it on mount', async () => {
    const invoke = vi.fn(async (_action: string) => paused); bridge(invoke); render(<App />);
    await screen.findByText('Paused · Downloading');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(invoke.mock.calls.every(([action]) => ['getSyncStatus', 'getAutomaticUploadStatus'].includes(action))).toBe(true);
  });
  it('continues through short steps and shows completion instead of a permanent spinner', async () => {
    let status = paused;
    const invoke = vi.fn(async (action: string) => {
      if (['getSyncStatus', 'getAutomaticUploadStatus'].includes(action)) return status;
      if (action === 'beginSync') return { status: { ...paused, state: 'running' }, step: 1 };
      if (action === 'advanceSync') { status = { ...paused, revision: 2, state: 'completed', resumable: false, stage: 'finished' }; return { status, step: 2 }; }
      return { success: true };
    });
    bridge(invoke); render(<App />); await screen.findByText('Paused · Downloading');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Completed · Finished');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull());
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
