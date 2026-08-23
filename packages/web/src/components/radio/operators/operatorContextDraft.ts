export function applyOperatorContextDraft<T extends object>(
  ref: { current: T },
  setDraft: (next: T) => void,
  patch: Partial<T>,
): T {
  const next = { ...ref.current, ...patch };
  ref.current = next;
  setDraft(next);
  return next;
}
