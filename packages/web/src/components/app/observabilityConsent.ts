import type { ObservabilityStatus } from '@tx5dr/contracts';

export function shouldRequestObservabilityConsent(
  eligible: boolean,
  status: ObservabilityStatus | null,
): boolean {
  return eligible && status?.noticeRequired === true;
}
