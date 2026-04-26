import { describe, expect, it } from 'vitest';
import {
  getPluginPageFileScopePath,
  getPluginPageStorePath,
} from '../utils/page-scope.js';

describe('page scope utilities', () => {
  it('builds matching page-scoped file paths for a callsign-bound global instance', () => {
    const fileScope = getPluginPageFileScopePath('settings', {
      instanceTarget: { kind: 'global' },
      resource: { kind: 'callsign', value: 'bg5drb' },
    });

    expect(fileScope).toBe('page-resources/instances/global/resources/callsigns/BG5DRB/settings');
  });

  it('keeps page stores isolated by operator instance target', () => {
    const operatorOnePath = getPluginPageStorePath('settings', {
      instanceTarget: { kind: 'operator', operatorId: 'operator-1' },
    });
    const operatorTwoPath = getPluginPageStorePath('settings', {
      instanceTarget: { kind: 'operator', operatorId: 'operator-2' },
    });

    expect(operatorOnePath).not.toEqual(operatorTwoPath);
    expect(operatorOnePath).toContain('instances/operators/operator-1');
  });
});
