import type { TFunction } from 'i18next';
import type { DesktopStationConnectState, DesktopStationProbeResult } from '@tx5dr/contracts';

/** User-facing explanation of a failed station connection. */
export function describeConnectError(t: TFunction, error: DesktopStationConnectState['error']): string {
  if (!error) return '';
  switch (error.kind) {
    case 'unreachable': return t('stations:errors.unreachable', { code: error.code ?? '' });
    case 'not-a-station': return t('stations:errors.notStation');
    case 'bridge-too-old': return t('stations:errors.bridgeTooOld', { required: error.required ?? '' });
    case 'redirect': return t('stations:errors.redirect', { location: error.location ?? '' });
    case 'gateway': return t('stations:errors.gateway', { code: error.code ?? '' });
    case 'load': return t('stations:errors.load', { code: error.code ?? '' });
    case 'certificate-changed': return t('stations:cert.changedBody');
  }
}

/** User-facing explanation of a probe that did not find a usable station. */
export function describeProbeFailure(t: TFunction, result: DesktopStationProbeResult): string {
  switch (result.kind) {
    case 'invalid-url': return t('stations:errors.invalidUrl');
    case 'unreachable': return t('stations:errors.unreachable', { code: result.code });
    case 'not-a-station': return t('stations:errors.notStation');
    case 'bridge-too-old': return t('stations:errors.bridgeTooOld', { required: result.required });
    case 'redirect': return t('stations:errors.redirect', { location: result.location });
    case 'certificate-changed': return t('stations:cert.changedBody');
    default: return '';
  }
}

/** Host and port of a station address, for compact display. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
