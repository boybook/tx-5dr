import { describe, expect, it } from 'vitest';
import { PluginPageSessionStore } from '../PluginPageSessionStore.js';

describe('PluginPageSessionStore', () => {
  it('stores and returns active sessions', () => {
    const store = new PluginPageSessionStore(1_000);
    const session = store.create({
      pluginName: 'lotw-sync',
      pageId: 'settings',
      accessScope: 'operator',
      instanceTarget: { kind: 'global' },
      resource: { kind: 'callsign', value: 'BG4IAJ' },
    });

    expect(store.get(session.sessionId)).toEqual(session);
  });

  it('expires sessions after ttl', async () => {
    const store = new PluginPageSessionStore(10);
    const session = store.create({
      pluginName: 'lotw-sync',
      pageId: 'settings',
      accessScope: 'operator',
      instanceTarget: { kind: 'global' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.get(session.sessionId)).toBeNull();
  });

  it('filters sessions by plugin instance target', () => {
    const store = new PluginPageSessionStore(1_000);
    const globalSession = store.create({
      pluginName: 'demo',
      pageId: 'settings',
      accessScope: 'admin',
      instanceTarget: { kind: 'global' },
    });
    store.create({
      pluginName: 'demo',
      pageId: 'settings',
      accessScope: 'admin',
      instanceTarget: { kind: 'operator', operatorId: 'operator-1' },
    });

    expect(
      store.listByPluginInstance('demo', { kind: 'global' }),
    ).toEqual([globalSession]);
  });

  it('touch extends session expiry', async () => {
    const store = new PluginPageSessionStore(20);
    const session = store.create({
      pluginName: 'demo',
      pageId: 'settings',
      accessScope: 'admin',
      instanceTarget: { kind: 'global' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const touched = store.touch(session.sessionId);
    expect(touched).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.get(session.sessionId)?.sessionId).toBe(session.sessionId);
  });
});
