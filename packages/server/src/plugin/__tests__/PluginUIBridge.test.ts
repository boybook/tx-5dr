import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { PluginUIBridge } from '../PluginUIBridge.js';
import { PluginDataBoundaryError } from '../plugin-data-boundary.js';

function createSession(pageId = 'settings') {
  return {
    sessionId: 'session-1',
    pluginName: 'demo',
    pageId,
    accessScope: 'operator' as const,
    instanceTarget: { kind: 'operator' as const, operatorId: 'operator-1' },
    createdAt: 0,
    expiresAt: Date.now() + 1_000,
  };
}

describe('PluginUIBridge', () => {
  it('refreshes only the owning operator projection', () => {
    const refresh = vi.fn();
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      new EventEmitter<DigitalRadioEngineEvents>(),
      () => [],
      undefined,
      undefined,
      refresh,
    );
    bridge.refreshOperatorProjection();
    expect(refresh).toHaveBeenCalledWith('operator-1');
  });

  it('pushes to the only active page session when using pushToPage', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const listener = vi.fn();
    eventEmitter.on('pluginPagePush', listener);

    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [createSession()],
    );

    bridge.pushToPage('settings', 'updated', { ok: true });

    expect(listener).toHaveBeenCalledWith({
      pluginName: 'demo',
      pageId: 'settings',
      pageSessionId: 'session-1',
      action: 'updated',
      data: { ok: true },
    });
  });

  it('requires explicit session targeting when multiple sessions are active', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'global' },
      eventEmitter,
      () => ([
        {
          sessionId: 'session-1',
          pluginName: 'demo',
          pageId: 'settings',
          accessScope: 'admin',
          instanceTarget: { kind: 'global' as const },
          createdAt: 0,
          expiresAt: Date.now() + 1_000,
        },
        {
          sessionId: 'session-2',
          pluginName: 'demo',
          pageId: 'settings',
          accessScope: 'admin',
          instanceTarget: { kind: 'global' as const },
          createdAt: 0,
          expiresAt: Date.now() + 1_000,
        },
      ]),
    );

    expect(() => bridge.pushToPage('settings', 'updated')).toThrow('explicit_page_session_required');
  });

  it('rejects pushToSession when the target session is not owned by the current instance', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => ([
        {
          sessionId: 'session-1',
          pluginName: 'demo',
          pageId: 'settings',
          accessScope: 'operator',
          instanceTarget: { kind: 'operator', operatorId: 'operator-1' },
          createdAt: 0,
          expiresAt: Date.now() + 1_000,
        },
      ]),
    );

    expect(() => bridge.pushToSession('session-2', 'updated')).toThrow('page_session_not_found');
  });

  it('forwards runtime panel contribution groups for the current plugin instance', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const onContributions = vi.fn();
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [],
      undefined,
      onContributions,
    );

    const panels = [{
      id: 'dynamic-panel',
      title: 'Dynamic',
      component: 'iframe' as const,
      pageId: 'dashboard',
      params: { tabId: 'one' },
      slot: 'voice-right-top' as const,
    }];
    bridge.setPanelContributions('voice-tabs', panels);

    expect(onContributions).toHaveBeenCalledWith(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      'voice-tabs',
      panels,
    );
  });

  it('detaches panel data with the existing JSON normalization semantics', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const listener = vi.fn();
    eventEmitter.on('pluginData', listener);
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [],
    );
    const sentAt = new Date('2026-08-23T01:02:03.000Z');
    const data = {
      nested: { value: 'before' },
      sentAt,
      omitted: undefined,
      invalidNumber: Number.NaN,
      custom: {
        raw: 'ignored',
        toJSON: () => ({ normalized: true }),
      },
    };

    bridge.send('status', data);
    data.nested.value = 'after';

    expect(listener).toHaveBeenCalledWith({
      pluginName: 'demo',
      operatorId: 'operator-1',
      panelId: 'status',
      data: {
        nested: { value: 'before' },
        sentAt: '2026-08-23T01:02:03.000Z',
        invalidNumber: null,
        custom: { normalized: true },
      },
    });
  });

  it('detaches panel metadata once before sharing it with callbacks and events', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const listener = vi.fn();
    const onPanelMeta = vi.fn();
    eventEmitter.on('pluginPanelMeta', listener);
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [],
      onPanelMeta,
    );
    const meta = {
      title: 'statusActive',
      titleValues: { state: { label: 'before' } },
    };

    bridge.setPanelMeta('status', meta);
    (meta.titleValues.state as { label: string }).label = 'after';

    const callbackPayload = onPanelMeta.mock.calls[0]?.[0];
    const eventPayload = listener.mock.calls[0]?.[0];
    expect(callbackPayload).toBe(eventPayload);
    expect(eventPayload).toMatchObject({
      pluginName: 'demo',
      operatorId: 'operator-1',
      panelId: 'status',
      meta: {
        title: 'statusActive',
        titleValues: { state: { label: 'before' } },
      },
    });
  });

  it('detaches runtime panel contributions before passing them to the manager callback', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const onContributions = vi.fn();
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [],
      undefined,
      onContributions,
    );
    const panels = [{
      id: 'dynamic-panel',
      title: 'Dynamic',
      component: 'iframe' as const,
      pageId: 'dashboard',
      params: { tabId: 'before' },
    }];

    bridge.setPanelContributions('voice-tabs', panels);
    panels[0].params.tabId = 'after';

    expect(onContributions.mock.calls[0]?.[3]).toEqual([{
      id: 'dynamic-panel',
      title: 'Dynamic',
      component: 'iframe',
      pageId: 'dashboard',
      params: { tabId: 'before' },
    }]);
    expect(onContributions.mock.calls[0]?.[3]).not.toBe(panels);
  });

  it.each([
    ['pushToPage', (bridge: PluginUIBridge, data: unknown) => bridge.pushToPage('settings', 'updated', data)],
    ['pushToSession', (bridge: PluginUIBridge, data: unknown) => bridge.pushToSession('session-1', 'updated', data)],
  ])('detaches page push data sent through %s', (_name, push) => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const listener = vi.fn();
    eventEmitter.on('pluginPagePush', listener);
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [createSession()],
    );
    const data = { nested: { value: 'before' } };

    push(bridge, data);
    data.nested.value = 'after';

    expect(listener.mock.calls[0]?.[0].data).toEqual({ nested: { value: 'before' } });
  });

  it.each([
    ['cyclic values', (() => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    })()],
    ['BigInt values', { value: 1n }],
  ])('rejects %s before emitting UI data', (_name, data) => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const listener = vi.fn();
    eventEmitter.on('pluginData', listener);
    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [],
    );

    expect(() => bridge.send('status', data)).toThrow(PluginDataBoundaryError);
    expect(listener).not.toHaveBeenCalled();
  });
});
