import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { PluginUIBridge } from '../PluginUIBridge.js';

describe('PluginUIBridge', () => {
  it('pushes to the only active page session when using pushToPage', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const listener = vi.fn();
    eventEmitter.on('pluginPagePush', listener);

    const bridge = new PluginUIBridge(
      'demo',
      { kind: 'operator', operatorId: 'operator-1' },
      eventEmitter,
      () => [{
        sessionId: 'session-1',
        pluginName: 'demo',
        pageId: 'settings',
        accessScope: 'operator',
        instanceTarget: { kind: 'operator', operatorId: 'operator-1' },
        createdAt: 0,
        expiresAt: Date.now() + 1_000,
      }],
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
});
