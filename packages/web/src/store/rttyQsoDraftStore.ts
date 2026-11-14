import { createQsoDraftStore } from './qsoDraftStore';

/** Shared RTTY QSO draft (log card ↔ macro placeholders ↔ receive terminal). */
export const rttyQsoDraftStore = createQsoDraftStore({
  hisCallsign: '',
  trst: '599',
  rrst: '599',
});

export const useRttyQSODraft = rttyQsoDraftStore.useDraft;
