import { describe, expect, it } from 'vitest';
import { getPluginPageUrl } from '../windowManager';

describe('getPluginPageUrl', () => {
  it('creates distinct standalone URLs for simultaneous operator pages', () => {
    const base = 'https://station.example/app/index.html';
    const first = getPluginPageUrl({
      pluginName: 'ww-digi',
      pageId: 'contest-log',
      operatorId: 'operator-a',
      params: { panelId: 'contest-log' },
    }, base);
    const second = getPluginPageUrl({
      pluginName: 'ww-digi',
      pageId: 'contest-log',
      operatorId: 'operator-b',
      params: { panelId: 'contest-log' },
    }, base);

    expect(first).toBe('https://station.example/app/plugin-page.html?panelId=contest-log&pluginName=ww-digi&pageId=contest-log&operatorId=operator-a');
    expect(second).toContain('operatorId=operator-b');
    expect(second).not.toBe(first);
  });

  it('does not let plugin params override host routing identity', () => {
    const url = getPluginPageUrl({
      pluginName: 'ww-digi',
      pageId: 'contest-log',
      operatorId: 'operator-a',
      params: { pluginName: 'other', operatorId: 'operator-b' },
    }, 'https://station.example/index.html');
    const query = new URL(url).searchParams;
    expect(query.get('pluginName')).toBe('ww-digi');
    expect(query.get('operatorId')).toBe('operator-a');
  });
});
