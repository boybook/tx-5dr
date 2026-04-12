import { describe, expect, it } from 'vitest';
import {
  getPluginPageFileScopePath,
  getPluginPageStorePath,
} from '../page-scope.js';

describe('page-scope', () => {
  it('isolates operator-scoped page store paths even when no resource is bound', () => {
    const operatorOnePath = getPluginPageStorePath('settings', {
      instanceTarget: { kind: 'operator', operatorId: 'operator-1' },
    });
    const operatorTwoPath = getPluginPageStorePath('settings', {
      instanceTarget: { kind: 'operator', operatorId: 'operator-2' },
    });

    expect(operatorOnePath).not.toEqual(operatorTwoPath);
    expect(operatorOnePath).toContain('instances');
    expect(operatorOnePath).toContain('operator-1');
  });

  it('keeps file scope page-specific within the same instance/resource scope', () => {
    const baseScope = {
      instanceTarget: { kind: 'global' as const },
      resource: { kind: 'callsign' as const, value: 'BG4IAJ' },
    };

    const settingsPath = getPluginPageFileScopePath('settings', baseScope);
    const dashboardPath = getPluginPageFileScopePath('dashboard', baseScope);

    expect(settingsPath).not.toEqual(dashboardPath);
    expect(settingsPath).toContain('page-resources');
    expect(settingsPath).toContain('settings');
  });
});
