import type { ParsedFT8Message, FrameMessage, SlotInfo } from '@tx5dr/contracts';
import type { StrategyDecision, StrategyDecisionMeta } from './hooks.js';

export type StrategyRuntimeSlot = 'TX1' | 'TX2' | 'TX3' | 'TX4' | 'TX5' | 'TX6';

export interface StrategyRuntimeContext {
  targetCallsign?: string;
  targetGrid?: string;
  reportSent?: number;
  reportReceived?: number;
  actualFrequency?: number;
}

export interface StrategyRuntimeSnapshot {
  currentState: string;
  slots?: Partial<Record<StrategyRuntimeSlot, string>>;
  context?: StrategyRuntimeContext;
  availableSlots?: string[];
}

export interface StrategyRuntimeSlotContentUpdate {
  slot: StrategyRuntimeSlot;
  content: string;
}

export interface StrategyRuntime {
  decide(
    messages: ParsedFT8Message[],
    meta?: StrategyDecisionMeta,
  ): Promise<StrategyDecision> | StrategyDecision;
  getTransmitText(): string | null;
  requestCall(
    callsign: string,
    lastMessage?: { message: FrameMessage; slotInfo: SlotInfo },
  ): void;
  getSnapshot(): StrategyRuntimeSnapshot;
  patchContext(patch: Partial<StrategyRuntimeContext>): void;
  setState(state: StrategyRuntimeSlot): void;
  setSlotContent(update: StrategyRuntimeSlotContentUpdate): void;
  reset(reason?: string): void;
  onTransmissionQueued?(transmission: string): void;
}
