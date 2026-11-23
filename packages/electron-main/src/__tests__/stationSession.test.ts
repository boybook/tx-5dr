import { describe, expect, it } from 'vitest';
import { classifyStationNavigation, isRemoteStationPermissionAllowed, remoteStationWebPreferences } from '../stationSession.js';

const ORIGIN = 'http://127.0.0.1:18100';

describe('remote station navigation', () => {
  it('stays on the gateway origin and sends other web links to the browser', () => {
    expect(classifyStationNavigation(`${ORIGIN}/logbook.html?x=1`, ORIGIN)).toBe('allow');
    expect(classifyStationNavigation('http://127.0.0.1:18101/', ORIGIN)).toBe('external');
    expect(classifyStationNavigation('https://qrz.com/db/BG7XXX', ORIGIN)).toBe('external');
    expect(classifyStationNavigation('file:///etc/passwd', ORIGIN)).toBe('deny');
    expect(classifyStationNavigation('javascript:alert(1)', ORIGIN)).toBe('deny');
    expect(classifyStationNavigation('not a url', ORIGIN)).toBe('deny');
  });
});

describe('remote station permissions', () => {
  it('grants only the station UI permissions to the gateway origin', () => {
    expect(isRemoteStationPermissionAllowed('media', `${ORIGIN}/`, ORIGIN, ['audio'])).toBe(true);
    expect(isRemoteStationPermissionAllowed('notifications', `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isRemoteStationPermissionAllowed('media', `${ORIGIN}/`, ORIGIN, ['audio', 'video'])).toBe(false);
    expect(isRemoteStationPermissionAllowed('geolocation', `${ORIGIN}/`, ORIGIN)).toBe(false);
    expect(isRemoteStationPermissionAllowed('media', 'https://evil.example/', ORIGIN, ['audio'])).toBe(false);
    expect(isRemoteStationPermissionAllowed('media', null, ORIGIN, ['audio'])).toBe(false);
  });

  it('builds isolated web preferences with web security enabled', () => {
    expect(remoteStationWebPreferences({ preload: '/p.js', partition: 'persist:station-x', bridgeArguments: ['--a'] })).toMatchObject({
      partition: 'persist:station-x',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      additionalArguments: ['--a'],
    });
  });
});
