export type SimulationMode = 'FT8' | 'FT4';

/** One protocol identity that a reusable virtual RF peer may assume. */
export interface SimulationPeerIdentity {
  callsign: string;
  grid: string;
}

export interface SimulationScenarioChoice {
  weight?: number;
  reply?: string;
  /** Send on the received frequency by default, or on the peer's configured frequency. */
  replyFrequency?: 'received' | 'peer';
  repeatLast?: boolean;
  silence?: boolean;
  complete?: boolean;
  nextState?: string;
  delayCycles?: number;
  /** Move a reusable peer to another identity after applying this choice. */
  advanceIdentity?: boolean;
}

export interface SimulationScenarioRule {
  /** Full-message regular expression. The Host applies case-insensitive anchoring. */
  pattern: string;
  choices: SimulationScenarioChoice[];
}

export interface SimulationScenarioTimeoutRule {
  afterReceiveCycles: number;
  choices: SimulationScenarioChoice[];
}

export interface SimulationScenarioState {
  rules?: SimulationScenarioRule[];
  timeouts?: SimulationScenarioTimeoutRule[];
}

export interface SimulationAddressedRestartPolicy {
  /**
   * States whose RF peer may be reassigned to a dormant identity. Addressed
   * rules must contain `{{peerCallsign}}`, and the decoded callsign must be a
   * standalone message token.
   */
  reclaimableStates: string[];
  /** Allow a choice that marked the peer complete to restart on a new addressed exchange. */
  restartCompleted?: boolean;
}

/** Declarative protocol-peer state machine used only by the development simulator. */
export interface SimulationScenarioDescriptor {
  id: string;
  modes: SimulationMode[];
  initialState: string;
  /**
   * Allow a completed or explicitly reclaimable peer, or a dormant pooled
   * identity, to restart when an addressed message matches a global or
   * initial-state rule.
   */
  addressedRestart?: SimulationAddressedRestartPolicy;
  /** Rules evaluated before the current state's rules, for protocol messages that may interrupt any state. */
  globalRules?: SimulationScenarioRule[];
  /** Optional identities reused by a bounded number of configured RF peer slots. */
  identityPool?: SimulationPeerIdentity[];
  states: Record<string, SimulationScenarioState>;
}
