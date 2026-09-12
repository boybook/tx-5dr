// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { PluginSystemSnapshot } from '@tx5dr/contracts';
import { PluginSnapshotProvider, usePluginSnapshot } from '../usePluginSnapshot';

const mocks = vi.hoisted(() => ({
  getPlugins: vi.fn(),
  auth: { authEnabled: true, jwt: 'session-one' as string | null, role: 'admin' },
  connection: { isReady: true, radioService: null as unknown },
  registerLocales: vi.fn(),
}));
vi.mock('@tx5dr/core', () => ({ api: { getPlugins: mocks.getPlugins } }));
vi.mock('../../store/authStore', () => ({ useAuth: () => ({ state: mocks.auth }) }));
vi.mock('../../store/radio/hooks', () => ({ useConnection: () => ({ state: mocks.connection }) }));
vi.mock('../../utils/pluginLocales', () => ({ registerPluginLocales: mocks.registerLocales }));

let bus: EventEmitter;
function snapshot(generation: number): PluginSystemSnapshot {
  return { generation, state: 'ready', plugins: [], panelMeta: [], panelContributions: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Consumer({ name }: { name: string }) {
  const value = usePluginSnapshot();
  return <output data-testid={name}>{JSON.stringify(value)}</output>;
}
const readers = <><Consumer name="one" /><Consumer name="two" /><Consumer name="three" /></>;
const read = () => JSON.parse(screen.getByTestId('one').textContent!);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = { authEnabled: true, jwt: 'session-one', role: 'admin' };
  bus = new EventEmitter();
  mocks.connection = { isReady: true, radioService: { wsClientInstance: { onWSEvent: bus.on.bind(bus), offWSEvent: bus.off.bind(bus) } } };
});
afterEach(cleanup);

describe('shared plugin snapshot lifetime', () => {
  it('loads once and subscribes once for any number of readers, then cleans up', async () => {
    mocks.getPlugins.mockResolvedValue(snapshot(1));
    const view = render(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    await act(async () => {});
    expect(mocks.getPlugins).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('pluginList')).toBe(1);
    expect(bus.listenerCount('pluginStatusChanged')).toBe(1);
    expect(bus.listenerCount('pluginPanelContributionsChanged')).toBe(1);
    expect(screen.getByTestId('two').textContent).toBe(screen.getByTestId('one').textContent);
    view.unmount();
    expect(bus.eventNames()).toEqual([]);
  });

  it('replays full snapshots and contribution deltas over a late REST response', async () => {
    const request = deferred<PluginSystemSnapshot>();
    mocks.getPlugins.mockReturnValue(request.promise);
    render(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    const group = { pluginName: 'external-plugin', groupId: 'live', panels: [{ id: 'panel' }] };
    act(() => {
      bus.emit('pluginList', snapshot(3));
      bus.emit('pluginPanelContributionsChanged', group);
    });
    await act(async () => request.resolve(snapshot(1)));
    expect(read()).toMatchObject({ generation: 3, panelContributions: [group] });
    act(() => bus.emit('pluginList', snapshot(2)));
    expect(read().generation).toBe(3);
  });

  it('does not replay an older full snapshot over a newer REST generation', async () => {
    const request = deferred<PluginSystemSnapshot>();
    mocks.getPlugins.mockReturnValue(request.promise);
    render(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    act(() => bus.emit('pluginList', snapshot(2)));
    await act(async () => request.resolve(snapshot(5)));
    expect(read().generation).toBe(5);
  });

  it('hides data immediately on permission loss and ignores the old request', async () => {
    const request = deferred<PluginSystemSnapshot>();
    mocks.getPlugins.mockReturnValue(request.promise);
    const view = render(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    act(() => bus.emit('pluginList', snapshot(7)));
    mocks.auth = { authEnabled: true, jwt: null, role: 'viewer' };
    view.rerender(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    expect(read().generation).toBe(0);
    expect(bus.eventNames()).toEqual([]);
    await act(async () => request.resolve(snapshot(8)));
    expect(read().generation).toBe(0);
    expect(mocks.getPlugins).toHaveBeenCalledTimes(1);
  });

  it('isolates identity changes and accepts a restarted Host after reconnect', async () => {
    const first = deferred<PluginSystemSnapshot>();
    const second = deferred<PluginSystemSnapshot>();
    mocks.getPlugins.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(snapshot(1));
    const view = render(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    act(() => bus.emit('pluginList', snapshot(8)));
    mocks.auth = { ...mocks.auth, jwt: 'session-two' };
    view.rerender(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    expect(read().generation).toBe(0);
    await act(async () => first.resolve(snapshot(20)));
    expect(read().generation).toBe(0);
    await act(async () => second.resolve(snapshot(9)));
    mocks.connection = { ...mocks.connection, isReady: false };
    view.rerender(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    expect(read().generation).toBe(9);
    mocks.connection = { ...mocks.connection, isReady: true };
    view.rerender(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    await act(async () => {});
    expect(read().generation).toBe(1);
    expect(bus.listenerCount('pluginList')).toBe(1);
  });

  it('keeps live events working when hydration fails', async () => {
    const request = deferred<PluginSystemSnapshot>();
    mocks.getPlugins.mockReturnValue(request.promise);
    render(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    await act(async () => request.reject(new Error('offline')));
    act(() => bus.emit('pluginList', snapshot(2)));
    expect(read().generation).toBe(2);
  });

  it('coalesces repeated entries without moving an old update past a full snapshot', async () => {
    const request = deferred<PluginSystemSnapshot>();
    mocks.getPlugins.mockReturnValue(request.promise);
    render(<PluginSnapshotProvider>{readers}</PluginSnapshotProvider>);
    const group = { pluginName: 'external', groupId: 'live', panels: [{ id: 'old' }] };
    const plugin = { name: 'external', version: '2' };
    act(() => {
      bus.emit('pluginPanelContributionsChanged', group);
      bus.emit('pluginList', { ...snapshot(2), panelContributions: [group] });
      bus.emit('pluginPanelContributionsChanged', { ...group, panels: [] });
      bus.emit('pluginStatusChanged', { generation: 3, plugin });
      bus.emit('pluginStatusChanged', { generation: 2, plugin: { ...plugin, version: 'old' } });
    });
    await act(async () => request.resolve(snapshot(1)));
    expect(read()).toMatchObject({ generation: 3, plugins: [plugin], panelContributions: [] });
  });
});
