import * as React from 'react';
import type { StrategyActionDescriptor, StrategyAttention } from '@tx5dr/contracts';
import { OperatorStrategyActions } from './OperatorStrategyActions';

const TONE_CLASS: Record<StrategyAttention['tone'], string> = {
  danger: 'bg-danger-50 text-danger-700',
  warning: 'bg-warning-50 text-warning-700',
  success: 'bg-success-50 text-success-700',
  info: 'bg-primary-50 text-primary-700',
};

export function resolveAttentionActions(
  attention: StrategyAttention,
  actions: readonly StrategyActionDescriptor[],
): StrategyActionDescriptor[] {
  if (!attention.actionIds?.length) return [];
  const byId = new Map(actions.map((action) => [action.id, action]));
  return attention.actionIds.flatMap((id) => {
    const action = byId.get(id);
    return action ? [action] : [];
  });
}

export function resolveStandaloneActions(
  attentions: readonly StrategyAttention[],
  actions: readonly StrategyActionDescriptor[],
): StrategyActionDescriptor[] {
  const attached = new Set(attentions.flatMap((attention) => attention.actionIds ?? []));
  return actions.filter((action) => !attached.has(action.id));
}

export function OperatorStrategyAttention({
  attention,
  actions,
  resolveText,
  onInvoke,
  onNavigate,
  onRequestSpectrumPick,
  className = '',
}: {
  attention: StrategyAttention;
  actions: readonly StrategyActionDescriptor[];
  resolveText: (value: string, params?: Record<string, string | number>) => string;
  onInvoke: (action: StrategyActionDescriptor, payload?: unknown) => void;
  onNavigate?: (action: StrategyActionDescriptor) => void;
  onRequestSpectrumPick?: (action: StrategyActionDescriptor) => void;
  className?: string;
}) {
  const attachedActions = resolveAttentionActions(attention, actions);
  return (
    <div
      role="alert"
      className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[11px] ${TONE_CLASS[attention.tone]} ${className}`}
    >
      <div className="min-w-0 flex-1">
        <span className="font-medium">{resolveText(attention.title, attention.params)}</span>
        {attention.description && (
          <span className="ml-1">{resolveText(attention.description, attention.params)}</span>
        )}
      </div>
      {attachedActions.length > 0 && (
        <div className="shrink-0">
          <OperatorStrategyActions
            compact
            actions={attachedActions}
            resolveLabel={(value) => resolveText(value)}
            onInvoke={onInvoke}
            onNavigate={onNavigate}
            onRequestSpectrumPick={onRequestSpectrumPick}
          />
        </div>
      )}
    </div>
  );
}
