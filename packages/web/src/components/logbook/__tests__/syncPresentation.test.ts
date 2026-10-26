import { describe, expect, it } from 'vitest';
import type { SyncStatus, SyncStatusProjection } from '@tx5dr/contracts';
import { SyncPresentation } from '../syncPresentation';

const status: SyncStatus = { operationId: 'one', trigger: 'manual', launchId: 'click', revision: 2, operation: 'full_sync', state: 'completed', stage: 'finished', startedAt: 1, updatedAt: 2, processed: 10, downloaded: 10, imported: 10, updated: 0, uploaded: 0, skipped: 0, failed: 0, conflicts: 0, rejected: 0, resumable: false, errors: [] };
const projection = (value = status): SyncStatusProjection => ({ supported: true, available: true, status: value });
describe('sync client presentation', () => {
  it('keeps unused, historical success, unavailable and automatic success quiet', () => {
    const ui = new SyncPresentation('client');
    for (const value of [undefined, projection(), projection({ ...status, trigger: 'auto' }), { supported: true, available: false, status: null }]) {
      expect(ui.view('generic', value).showStrip).toBe(false);
      expect(ui.view('generic', value).badge).toBe(false);
    }
    expect(ui.observe({ generic: projection() })).toEqual([]);
  });
  it('shows automatic failures only as a badge and active manual work as a collapsible strip', () => {
    const ui = new SyncPresentation('client');
    const failure = projection({ ...status, trigger: 'auto', state: 'failed', failed: 1 });
    expect(ui.view('generic', failure)).toMatchObject({ badge: true, showStrip: false });
    const active = projection({ ...status, state: 'running', resumable: true });
    expect(ui.view('generic', active)).toMatchObject({ active: true, showStrip: true });
    expect(ui.view('generic', active, true)).toMatchObject({ active: false, unavailable: true, showStrip: true });
    ui.dismiss('generic', active.status!);
    expect(ui.view('generic', active).showStrip).toBe(false);
    expect(ui.view('other', active).showStrip).toBe(true);
  });
  it('keeps a completed run with permanent rejections visible', () => {
    const ui = new SyncPresentation('client');
    expect(ui.view('generic', projection({ ...status, rejected: 2 }))).toMatchObject({ badge: true, showStrip: false });
  });
  it('notifies only a locally launched result once, with a quiet reload baseline', () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const ui = new SyncPresentation('call-one', storage);
    ui.observe({ generic: projection({ ...status, state: 'running' }) }); ui.launched('generic', 'click');
    expect(ui.observe({ generic: projection() })).toHaveLength(1);
    expect(ui.observe({ generic: projection() })).toEqual([]);
    expect(new SyncPresentation('call-one', storage).observe({ generic: projection() })).toEqual([]);
    const other = new SyncPresentation('call-two', storage);
    other.observe({});
    expect(other.observe({ generic: projection() })).toEqual([]);
  });
  it('reestablishes a quiet baseline after disconnection', () => {
    const ui = new SyncPresentation('client');
    ui.launched('generic', 'click'); ui.observe({ generic: projection({ ...status, state: 'running' }) });
    ui.connectionLost();
    expect(ui.observe({ generic: projection() })).toEqual([]);
  });
  it('shows a resumable local failure without turning partial success into complete success', () => {
    const ui = new SyncPresentation('client'); ui.observe({ generic: projection({ ...status, state: 'running' }) }); ui.launched('generic', 'click');
    const partial = projection({ ...status, state: 'partial_failure', failed: 2, resumable: true });
    expect(ui.view('generic', partial)).toMatchObject({ badge: true, showStrip: true });
    expect(ui.observe({ generic: partial })[0]?.status.state).toBe('partial_failure');
  });
});
