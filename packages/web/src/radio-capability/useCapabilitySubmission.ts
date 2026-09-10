import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CapabilityState, CapabilityValue } from '@tx5dr/contracts';
import type { CapabilityComponentProps, CapabilityWriteFeedback } from './control-types';
import { CAPABILITY_WRITE_CONFIRM_TIMEOUT_MS } from './CapabilityWriteRequests';

interface Submission {
  sequence: number;
  value: CapabilityValue;
  baseline: CapabilityState | undefined;
  controlled: boolean;
}
interface Receipt { state: CapabilityState; baseline: CapabilityState | undefined }

/** Local presentation overlay; neither proposals nor pending writes modify the radio store. */
export function useCapabilitySubmission({ state, enabled, scope, onWrite }: {
  state: CapabilityState | undefined;
  enabled: boolean;
  scope: string;
  onWrite: CapabilityComponentProps['onWrite'];
}) {
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [failure, setFailure] = useState<{ error: string; timedOut?: boolean } | null>(null);
  const sequence = useRef(0);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ scope, enabled, state, mounted: false });
  live.current = { ...live.current, scope, enabled, state };
  const clearFallback = useCallback(() => {
    if (fallbackTimer.current !== null) clearTimeout(fallbackTimer.current);
    fallbackTimer.current = null;
  }, []);
  useLayoutEffect(() => {
    live.current.mounted = true;
    sequence.current += 1; clearFallback(); setSubmission(null); setReceipt(null); setFailure(null);
    return () => { live.current.mounted = false; sequence.current += 1; clearFallback(); };
  }, [scope, enabled, clearFallback]);

  useLayoutEffect(() => {
    if (receipt && state !== receipt.baseline) setReceipt(null);
    if (submission?.controlled && state !== submission.baseline && state?.value === submission.value) {
      clearFallback(); setSubmission(null);
    }
  }, [state, receipt, submission, clearFallback]);

  const write = useCallback<CapabilityComponentProps['onWrite']>((id, value, action) => {
    if (!live.current.mounted || !live.current.enabled || live.current.scope !== scope) return;
    if (action || value === undefined) return onWrite(id, value, action);
    const currentSequence = ++sequence.current;
    const baseline = live.current.state;
    clearFallback(); setFailure(null);
    setSubmission({ sequence: currentSequence, value, baseline, controlled: false });
    const settle = (feedback: CapabilityWriteFeedback) => {
      if (!live.current.mounted || !live.current.enabled || live.current.scope !== scope || sequence.current !== currentSequence) return;
      clearFallback(); setSubmission(null);
      if (feedback.outcome === 'completed') {
        const current = live.current.state;
        // The receipt is authoritative too. Bridge the short interval before its store projection renders.
        setReceipt(current && current.updatedAt > feedback.state.updatedAt ? null : { state: feedback.state, baseline: current });
      } else {
        if (feedback.outcome === 'failed') setFailure(feedback);
      }
    };
    try {
      const operation = onWrite(id, value, action);
      if (operation) {
        void operation.then(settle, reason => settle({ outcome: 'failed', error: reason instanceof Error ? reason.message : String(reason) }));
        return operation;
      }
      // A local controlled consumer acknowledges by publishing its value; it must never wait forever.
      setSubmission({ sequence: currentSequence, value, baseline, controlled: true });
      fallbackTimer.current = setTimeout(() => settle({ outcome: 'failed', error: 'Radio setting confirmation timed out', timedOut: true }), CAPABILITY_WRITE_CONFIRM_TIMEOUT_MS);
    } catch (reason) {
      settle({ outcome: 'failed', error: reason instanceof Error ? reason.message : String(reason) });
    }
  }, [scope, clearFallback, onWrite]);

  const displayedReceipt = receipt && state === receipt.baseline ? receipt.state : null;
  const displayState = submission && state ? { ...state, value: submission.value } : displayedReceipt ?? state;
  return { displayState, write, pending: submission !== null, error: failure?.error ?? null, timedOut: failure?.timedOut ?? false };
}
