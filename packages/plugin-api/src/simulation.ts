export type SimulationMode = 'FT8' | 'FT4';

export interface SimulationScenarioChoice {
  weight?: number;
  reply?: string;
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
  states: Record<string, SimulationScenarioState>;
}
