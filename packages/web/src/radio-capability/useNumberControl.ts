import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';
import { controlEditingKey, parseControlNumber } from './control-values';
import { formatCapabilityNumber } from './display-utils';

export const CAPABILITY_WRITE_DEBOUNCE_MS = 150;

/** Owns only a user's current edit, never a second copy of the radio's state. */
export function useNumberControl({ descriptor, state, enabled, scope, discrete, onWrite }: {
  descriptor: CapabilityDescriptor;
  state: CapabilityState | undefined;
  enabled: boolean;
  scope: string;
  discrete: boolean;
  onWrite: (value: number) => void;
}) {
  const actual = typeof state?.value === 'number' ? state.value : null;
  const [text, setText] = useState<string | null>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const draft = useRef<string | null>(null);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = `${scope}:${controlEditingKey(descriptor)}:${discrete}`;
  const live = useRef({ key, enabled, onWrite });
  live.current = { key, enabled, onWrite };

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);
  const cancel = useCallback(() => {
    clearTimer(); draft.current = null; setText(null); setDragValue(null);
  }, [clearTimer]);

  useLayoutEffect(() => {
    cancel();
    return clearTimer;
  }, [key, enabled, cancel, clearTimer]);

  useLayoutEffect(() => {
    if (state?.lastError) cancel();
  }, [state?.lastError, cancel]);

  const flush = useCallback(() => {
    const value = pending.current;
    clearTimer();
    if (value !== null && live.current.enabled && live.current.key === key) live.current.onWrite(value);
  }, [clearTimer, key]);

  const edit = useCallback((value: string) => {
    if (!enabled) return;
    clearTimer(); setDragValue(null); draft.current = value; setText(value);
  }, [clearTimer, enabled]);

  const commit = useCallback(() => {
    const value = draft.current;
    draft.current = null; setText(null);
    if (value === null || !live.current.enabled || live.current.key !== key) return;
    const parsed = parseControlNumber(value, descriptor, discrete);
    if (parsed !== null && parsed !== actual) live.current.onWrite(parsed);
  }, [actual, descriptor, discrete, key]);

  const slide = useCallback((value: number) => {
    if (!live.current.enabled || live.current.key !== key) return;
    clearTimer(); draft.current = null; setText(null); setDragValue(value); pending.current = value;
    timer.current = setTimeout(flush, CAPABILITY_WRITE_DEBOUNCE_MS);
  }, [clearTimer, flush, key]);

  const endSlide = useCallback(() => { flush(); setDragValue(null); }, [flush]);
  const displayValue = dragValue ?? actual;
  return {
    actual, displayValue, edit, commit, cancel, slide, endSlide,
    input: text ?? (displayValue === null ? '' : formatCapabilityNumber(displayValue, descriptor, false)),
  };
}
