import { describe, expect, it } from 'vitest';
import { resolvePluginPageParameters } from '../pluginPageParameters';

describe('resolvePluginPageParameters', () => {
  it('binds the standalone page to one operator and forwards custom params', () => {
    expect(resolvePluginPageParameters(
      '?pluginName=ww-digi&pageId=contest-log&operatorId=operator-a&panelId=contest-log',
    )).toEqual({
      pluginName: 'ww-digi',
      pageId: 'contest-log',
      operatorId: 'operator-a',
      params: { operatorId: 'operator-a', panelId: 'contest-log' },
      valid: true,
    });
  });

  it('keeps parallel operator pages isolated by URL context', () => {
    const first = resolvePluginPageParameters('?pluginName=ww-digi&pageId=contest-log&operatorId=operator-a');
    const second = resolvePluginPageParameters('?pluginName=ww-digi&pageId=contest-log&operatorId=operator-b');
    expect(first.params.operatorId).toBe('operator-a');
    expect(second.params.operatorId).toBe('operator-b');
  });

  it('does not forward host authentication or routing parameters to plugin params', () => {
    const result = resolvePluginPageParameters('?pluginName=x&pageId=y&auth_token=secret&view=compact');
    expect(result.params).toEqual({ view: 'compact' });
  });
});
