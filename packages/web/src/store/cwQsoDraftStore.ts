import { useSyncExternalStore } from 'react';

interface CWQSODraftState {
  hisCallsign: string;
  trst: string;
  rrst: string;
}

let state: CWQSODraftState = {
  hisCallsign: '',
  trst: '5NN',
  rrst: '5NN',
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

export function setCWQSOTrst(trst: string): void {
  const normalized = trst.trim().toUpperCase();
  if (state.trst === normalized) {
    return;
  }
  state = { ...state, trst: normalized };
  emit();
}

export function setCWQSORrst(rrst: string): void {
  const normalized = rrst.trim().toUpperCase();
  if (state.rrst === normalized) {
    return;
  }
  state = { ...state, rrst: normalized };
  emit();
}

export function useCWQSODraft(): CWQSODraftState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
