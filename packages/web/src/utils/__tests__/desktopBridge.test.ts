// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { getDesktopStationKind, hasDesktopCapability } from '../desktopBridge';

describe('desktop bridge detection', () => {
  afterEach(() => {
    window.electronAPI = undefined;
  });

  it('reports nothing in a plain browser', () => {
    expect(hasDesktopCapability('desktopUpdates')).toBe(false);
    expect(getDesktopStationKind()).toBeNull();
  });

  it('reports nothing for a shell without the bridge contract', () => {
    window.electronAPI = {} as typeof window.electronAPI;
    expect(hasDesktopCapability('windows')).toBe(false);
    expect(getDesktopStationKind()).toBeNull();
  });

  it('reports the capabilities granted to a remote station page', () => {
    window.electronAPI = {
      bridge: { version: 1, kind: 'remote', capabilities: ['windows', 'saveFile'] },
    } as typeof window.electronAPI;
    expect(getDesktopStationKind()).toBe('remote');
    expect(hasDesktopCapability('windows')).toBe(true);
    expect(hasDesktopCapability('openAppDirectory')).toBe(false);
  });
});
