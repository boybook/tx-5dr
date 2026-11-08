import { describe, expect, it } from 'vitest';
import {
  assertPluginApiCompatible,
  getPluginApiCompatibility,
  isPluginApiCompatible,
  PluginApiCompatibilityError,
} from '../compatibility.js';

describe('Plugin API caret compatibility', () => {
  it('accepts the same or a newer version within the same major', () => {
    expect(isPluginApiCompatible('2.5.0', '2.5.0')).toBe(true);
    expect(isPluginApiCompatible('2.5.0', '2.6.0')).toBe(true);
    expect(isPluginApiCompatible('2.5.0', '2.99.3')).toBe(true);
  });

  it('rejects an older Host and a newer major', () => {
    expect(isPluginApiCompatible('2.6.0', '2.5.9')).toBe(false);
    expect(isPluginApiCompatible('1.7.8', '2.6.0')).toBe(false);
    expect(isPluginApiCompatible('2.0.0', '3.0.0')).toBe(false);
  });

  it('follows caret boundaries for 0.x requirements', () => {
    expect(isPluginApiCompatible('0.4.1', '0.4.9')).toBe(true);
    expect(isPluginApiCompatible('0.4.1', '0.5.0')).toBe(false);
    expect(isPluginApiCompatible('0.0.3', '0.0.3')).toBe(true);
    expect(isPluginApiCompatible('0.0.3', '0.0.4')).toBe(false);
  });

  it('treats a Host prerelease as below its release', () => {
    expect(isPluginApiCompatible('2.7.0', '2.7.0-beta.1')).toBe(false);
    expect(isPluginApiCompatible('2.6.0', '2.7.0-beta.1')).toBe(true);
  });

  it('rejects invalid versions', () => {
    expect(isPluginApiCompatible('latest', '2.6.0')).toBe(false);
    expect(isPluginApiCompatible('2.6.0', 'unavailable')).toBe(false);
  });

  it('throws a stable error naming the caret range', () => {
    let failure: unknown;
    try {
      assertPluginApiCompatible('1.2.0', 'legacy-plugin', '2.6.0');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PluginApiCompatibilityError);
    expect(failure).toMatchObject({
      code: 'PLUGIN_API_VERSION_UNSUPPORTED',
      minPluginApiVersion: '1.2.0',
      pluginApiVersion: '2.6.0',
    });
    expect(String((failure as Error).message)).toContain('^1.2.0');
  });

  it('allows definitions without a requirement', () => {
    expect(() => assertPluginApiCompatible(undefined, 'local', '2.6.0')).not.toThrow();
  });

  it('classifies requirements for the loader legacy window', () => {
    expect(getPluginApiCompatibility('2.5.0', '2.7.0')).toBe('compatible');
    expect(getPluginApiCompatibility('1.7.11', '2.7.0')).toBe('legacy');
    expect(getPluginApiCompatibility('1.0.0', '2.7.0')).toBe('legacy');
    expect(getPluginApiCompatibility('1.7.11', '3.0.0')).toBe('unsupported');
    expect(getPluginApiCompatibility('0.9.0', '2.7.0')).toBe('unsupported');
    expect(getPluginApiCompatibility('2.8.0', '2.7.0')).toBe('requires-newer-host');
    expect(getPluginApiCompatibility('3.0.0', '2.7.0')).toBe('requires-newer-host');
    expect(getPluginApiCompatibility('soon', '2.7.0')).toBe('unsupported');
  });

  it('accepts legacy requirements only when the caller allows them', () => {
    expect(() => assertPluginApiCompatible('1.7.11', 'legacy', '2.7.0')).toThrow(PluginApiCompatibilityError);
    expect(assertPluginApiCompatible('1.7.11', 'legacy', '2.7.0', { allowLegacy: true })).toBe('legacy');
    expect(assertPluginApiCompatible('2.6.0', 'current', '2.7.0', { allowLegacy: true })).toBe('compatible');
    expect(() => assertPluginApiCompatible('2.8.0', 'future', '2.7.0', { allowLegacy: true }))
      .toThrow(expect.objectContaining({ compatibility: 'requires-newer-host' }));
    expect(() => assertPluginApiCompatible('0.9.0', 'ancient', '2.7.0', { allowLegacy: true }))
      .toThrow(expect.objectContaining({ compatibility: 'unsupported' }));
  });
});
