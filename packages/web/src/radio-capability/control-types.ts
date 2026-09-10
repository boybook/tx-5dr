import type { CapabilityDescriptor, CapabilityState, CapabilityValue } from '@tx5dr/contracts';

export type CapabilityWriteFeedback =
  | { outcome: 'completed'; state: CapabilityState }
  | { outcome: 'failed'; error: string; timedOut?: boolean }
  | { outcome: 'cancelled' };

/** Controlled local consumers can publish their next value synchronously. */
export type CapabilityWriteOperation = Promise<CapabilityWriteFeedback> | void;

export interface CapabilityComponentProps {
  capabilityId: string;
  descriptor: CapabilityDescriptor;
  state: CapabilityState | undefined;
  interactive: boolean;
  scope: string;
  onWrite: (id: string, value?: CapabilityValue, action?: boolean) => CapabilityWriteOperation;
  /** Presentation only: false moves the slider value into a tooltip instead of a companion input. */
  showSliderInput?: boolean;
  /** Shared capability details for renderers that own tooltip placement. */
  tooltipContent?: string;
  /** Atomic groups own text drafts and never dispatch scalar writes. */
  draftEditor?: { text: string; onChange: (text: string) => void };
}
