import { describe, expect, it } from 'vitest';
import { checkPluginProject, pluginApiRangeFloor } from '../project-check.js';

const pkg = (overrides: Record<string, unknown> = {}) => ({
  name: 'demo',
  version: '1.0.0',
  devDependencies: { '@tx5dr/plugin-api': '^2.7.0' },
  ...overrides,
});
const definition = (overrides: Record<string, unknown> = {}) => ({
  name: 'demo',
  version: '1.0.0',
  type: 'utility',
  minPluginApiVersion: '2.7.0',
  permissions: [],
  ...overrides,
});

describe('plugin project check', () => {
  it('accepts a declaration equal to the Plugin API it builds against', () => {
    const result = checkPluginProject(pkg(), definition());
    expect(result.errors).toEqual([]);
    expect(result.pluginApiFloor).toBe('2.7.0');
    expect(result.notes[0]).toContain('>= 2.7.0 and < 3.0.0');
  });

  it('suggests the floor when the declaration is missing or too low', () => {
    expect(checkPluginProject(pkg(), definition({ minPluginApiVersion: undefined })).errors[0])
      .toContain("minPluginApiVersion: '2.7.0'");
    expect(checkPluginProject(pkg(), definition({ minPluginApiVersion: '2.5.0' })).errors[0])
      .toContain('lower than the @tx5dr/plugin-api 2.7.0');
    expect(checkPluginProject(pkg(), definition({ minPluginApiVersion: '3.0.0' })).errors[0])
      .toContain('major');
  });

  it('accepts a declaration above the floor within the same major', () => {
    const result = checkPluginProject(
      pkg({ devDependencies: { '@tx5dr/plugin-api': '^2.6.0' } }),
      definition({ minPluginApiVersion: '2.7.0' }),
    );
    expect(result.errors).toEqual([]);
  });

  it('requires a declared @tx5dr/plugin-api dependency', () => {
    expect(checkPluginProject(pkg({ devDependencies: {} }), definition()).errors[0])
      .toContain('Add @tx5dr/plugin-api');
  });

  it('flags inconsistent versions and missing apiVersion 2', () => {
    const result = checkPluginProject(
      pkg({ tx5drPlugin: { minPluginApiVersion: '2.6.0' } }),
      definition({ version: '1.0.1', permissions: ['radio:control'] }),
    );
    expect(result.errors.join('\n')).toMatch(/differs from the plugin definition/);
    expect(result.errors.join('\n')).toMatch(/definition version \(1\.0\.1\) differs/);
    expect(result.errors.join('\n')).toMatch(/apiVersion: 2/);
  });

  it('does not report a missing declaration before the definition is built', () => {
    const result = checkPluginProject(pkg());
    expect(result.errors).toEqual([]);
    expect(result.warnings[0]).toContain('Build the plugin first');
  });

  it('checks package metadata alone before a build', () => {
    const result = checkPluginProject(pkg({ tx5drPlugin: { minPluginApiVersion: '2.7.0' } }));
    expect(result.errors).toEqual([]);
    expect(result.warnings[0]).toContain('Build the plugin first');
  });

  it('reads supported range floors', () => {
    expect(pluginApiRangeFloor('^2.6.0')).toBe('2.6.0');
    expect(pluginApiRangeFloor('>=2.0.0')).toBe('2.0.0');
    expect(pluginApiRangeFloor('workspace:*')).toBeUndefined();
  });
});
