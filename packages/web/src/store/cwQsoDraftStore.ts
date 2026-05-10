import { useSyncExternalStore } from 'react';

interface CWQSODraftState {
  hisCallsign: string;
}

let state: CWQSODraftState = {
  hisCallsign: '',
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): CWQSODraftState {
  return state;
}

export function setCWQSOHisCallsign(hisCallsign: string): void {
  const normalized = hisCallsign.trim().toUpperCase();
  if (state.hisCallsign === normalized) {
    return;
  }
  state = { ...state, hisCallsign: normalized };
  emit();
}

export function useCWQSODraft(): CWQSODraftState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
