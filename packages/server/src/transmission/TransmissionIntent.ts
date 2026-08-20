export type TransmissionIntentSource =
  | 'standard-qso'
  | 'plugin'
  | 'late-decode'
  | 'operator-edit'
  | 'manual'
  | 'persistence'
  | 'device';

export interface TransmissionIntent {
  operatorId?: string;
  source: TransmissionIntentSource;
  reason: string;
  slotId?: string;
  text?: string;
  decisionEpoch: number;
  replacesFrameId?: string;
}

export type FramePhase =
  | 'requested'
  | 'encoding'
  | 'ready'
  | 'prepared'
  | 'committed'
  | 'on_air'
  | 'draining'
  | 'terminal'
  | 'cancelled';

export interface FrameLease {
  frameId: string;
  slotId: string;
  participantOperatorIds: string[];
  decisionEpoch: number;
  revision: number;
  phase: FramePhase;
  terminalEmitted: boolean;
  superseded: boolean;
}

export type PhysicalTxSource =
  | 'digital'
  | 'voice'
  | 'voice-keyer'
  | 'cw'
  | 'tune-tone'
  | 'manual'
  | 'test';

export type PhysicalTxPhase =
  | 'idle'
  | 'starting'
  | 'active'
  | 'draining'
  | 'stopping'
  | 'unknown';

export interface PhysicalTxSnapshot {
  leaseId: string | null;
  frameId?: string;
  frameRevision?: number;
  source?: PhysicalTxSource;
  operatorIds: string[];
  phase: PhysicalTxPhase;
  epoch: number;
  playbackGeneration: number;
  pttConfirmed: boolean;
  startedAt?: number;
  reason?: string;
}
