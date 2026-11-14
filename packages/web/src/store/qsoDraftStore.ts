import { useSyncExternalStore } from 'react';

/**
 * Module-level QSO draft shared by a keyboard mode's panels: the QSO log card
 * writes it, the keyer resolves {HISCALL}/{TRST}/{RRST} from it and the
 * decoder "use callsign" action fills the callsign.
 */
export interface QsoDraftState {
  hisCallsign: string;
  trst: string;
  rrst: string;
}

export interface QsoDraftStore {
  getSnapshot(): QsoDraftState;
  setHisCallsign(hisCallsign: string): void;
  setTrst(trst: string): void;
  setRrst(rrst: string): void;
  /** React hook subscribing to the draft. */
  useDraft(): QsoDraftState;
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

export function createQsoDraftStore(defaults: QsoDraftState): QsoDraftStore {
  let state: QsoDraftState = { ...defaults };
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const getSnapshot = (): QsoDraftState => state;

  const setField = (field: keyof QsoDraftState, value: string): void => {
    const normalized = normalize(value);
    if (state[field] === normalized) {
      return;
    }
    state = { ...state, [field]: normalized };
    emit();
  };

  return {
    getSnapshot,
    setHisCallsign: (hisCallsign) => setField('hisCallsign', hisCallsign),
    setTrst: (trst) => setField('trst', trst),
    setRrst: (rrst) => setField('rrst', rrst),
    useDraft: function useDraft() {
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    },
  };
}
