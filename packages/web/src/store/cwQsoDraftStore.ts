import { createQsoDraftStore, type QsoDraftState } from './qsoDraftStore';

/** Shared CW QSO draft (log card ↔ keyer placeholders ↔ decoder callsign). */
export const cwQsoDraftStore = createQsoDraftStore({
  hisCallsign: '',
  trst: '5NN',
  rrst: '5NN',
});

export type CWQSODraftState = QsoDraftState;

export const setCWQSOHisCallsign = cwQsoDraftStore.setHisCallsign;
export const setCWQSOTrst = cwQsoDraftStore.setTrst;
export const setCWQSORrst = cwQsoDraftStore.setRrst;
export const useCWQSODraft = cwQsoDraftStore.useDraft;
