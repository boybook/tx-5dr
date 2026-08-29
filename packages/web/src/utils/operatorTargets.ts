import type { OperatorStatus } from '@tx5dr/contracts';

/** Resolves the canonical active target set with one-server-version compatibility. */
export function resolveOperatorTargetCallsigns(operator: OperatorStatus | undefined): string[] {
  const projected = operator?.context?.targetCalls ?? [];
  const candidates = projected.length > 0
    ? projected
    : [operator?.context?.targetCall ?? ''];
  return Array.from(new Set(
    candidates.map((callsign) => callsign.trim().toUpperCase()).filter(Boolean),
  ));
}
