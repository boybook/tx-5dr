export type SimulationMode = 'FT8' | 'FT4';

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

/** Declarative protocol-peer state machine used only by the development simulator. */
export interface SimulationScenarioDescriptor {
  id: string;
  modes: SimulationMode[];
  initialState: string;
  /** Rules evaluated before the current state's rules, for protocol messages that may interrupt any state. */
  globalRules?: SimulationScenarioRule[];
  states: Record<string, SimulationScenarioState>;
}
