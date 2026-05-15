import { api } from '@tx5dr/core';

export type SetRadioFrequencyParams = Parameters<typeof api.setRadioFrequency>[0];
export type SetRadioFrequencyResponse = Awaited<ReturnType<typeof api.setRadioFrequency>>;

export interface RadioFrequencyIntent {
  frequency: number;
  sentAt: number;
}

type IntentListener = (intent: RadioFrequencyIntent) => void;

const listeners = new Set<IntentListener>();

export function subscribeRadioFrequencyIntent(listener: IntentListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishRadioFrequencyIntent(frequency: number, sentAt = Date.now()): void {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    return;
  }

  const intent: RadioFrequencyIntent = {
    frequency: Math.round(frequency),
    sentAt,
  };
  for (const listener of listeners) {
    listener(intent);
  }
}

export async function setRadioFrequencyWithIntent(
  params: SetRadioFrequencyParams,
  apiBase?: string,
): Promise<SetRadioFrequencyResponse> {
  publishRadioFrequencyIntent(params.frequency);
  return api.setRadioFrequency(params, apiBase);
}
