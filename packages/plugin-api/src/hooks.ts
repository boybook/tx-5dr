import type { ParsedFT8Message, SlotInfo, QSORecord, FrameMessage } from '@tx5dr/contracts';
import type { PluginContext } from './context.js';

// ===== Candidate Scoring =====

/**
 * A decoded message with an attached score, used in onScoreCandidates pipeline.
 */
export interface ScoredCandidate extends ParsedFT8Message {
  score: number;
}

// ===== Strategy Runtime Decision =====

/**
 * The result returned by `StrategyRuntime.decide()`.
 */
export interface StrategyDecision {
  /** If true, the operator should stop transmitting. */
  stop?: boolean;
}

/**
 * Metadata for a strategy decision invocation.
 */
export interface StrategyDecisionMeta {
  /**
   * True when the framework is re-evaluating a late decode within the same TX window.
   * Strategy implementations should avoid treating this as a normal timeout tick.
   */
  isReDecision?: boolean;
}

// ===== Last Message Info =====

/**
 * Information about the last message received from a target station.
 */
export interface LastMessageInfo {
  message: FrameMessage;
  slotInfo: SlotInfo;
}

// ===== Hook Interfaces =====

/**
 * All available plugin hooks.
 *
 * Hooks are categorized into three types:
 * - **Pipeline**: Output feeds into the next plugin. Utility plugins compose, strategy plugins run last.
 * - **Exclusive**: Only the active strategy plugin can define these.
 * - **Broadcast**: All active plugins receive the call (fire-and-forget).
 */
export interface PluginHooks {
  // ===== Pipeline Hooks =====
  // These hooks are composable: each plugin's output feeds into the next.

  /**
   * Filter the candidate target list.
   * Return the filtered list. If you return an empty array when the input was non-empty,
   * the framework will skip your filter (safety net).
   */
  onFilterCandidates?(
    candidates: ParsedFT8Message[],
    ctx: PluginContext,
  ): ParsedFT8Message[] | Promise<ParsedFT8Message[]>;

  /**
   * Score candidates for target selection priority.
   * Modify the `score` field to influence ranking.
   */
  onScoreCandidates?(
    candidates: ScoredCandidate[],
    ctx: PluginContext,
  ): ScoredCandidate[] | Promise<ScoredCandidate[]>;

  // ===== Broadcast Hooks =====
  // All active plugins receive these. No return value.

  /**
   * Fired at the start of each time slot.
   */
  onSlotStart?(slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext): void;

  /**
   * Fired when decoded messages are available (even if the operator is not transmitting).
   */
  onDecode?(messages: ParsedFT8Message[], ctx: PluginContext): void;

  /**
   * Fired when a QSO begins (target callsign locked).
   */
  onQSOStart?(info: { targetCallsign: string; grid?: string }, ctx: PluginContext): void;

  /**
   * Fired when a QSO completes successfully.
   */
  onQSOComplete?(record: QSORecord, ctx: PluginContext): void;

  /**
   * Fired when a QSO fails or times out.
   */
  onQSOFail?(info: { targetCallsign: string; reason: string }, ctx: PluginContext): void;

  /**
   * Fired when a named timer triggers (set via ctx.timers.set()).
   */
  onTimer?(timerId: string, ctx: PluginContext): void;

  /**
   * Fired when the user clicks a quick action button.
   */
  onUserAction?(actionId: string, payload: unknown, ctx: PluginContext): void;

  /**
   * Fired when plugin settings change.
   */
  onConfigChange?(changes: Record<string, unknown>, ctx: PluginContext): void;
}
