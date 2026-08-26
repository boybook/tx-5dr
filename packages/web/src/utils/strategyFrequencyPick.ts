import type { StrategyActionTarget } from '@tx5dr/contracts';

export const STRATEGY_FREQUENCY_PICK_EVENT = 'tx5dr:strategy-frequency-pick';

export interface StrategyFrequencyPickRequest {
  operatorId: string;
  target: StrategyActionTarget;
  actionId: string;
}

export function requestStrategyFrequencyPick(detail: StrategyFrequencyPickRequest): void {
  window.dispatchEvent(new CustomEvent<StrategyFrequencyPickRequest>(STRATEGY_FREQUENCY_PICK_EVENT, { detail }));
}
