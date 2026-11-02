import type { PlaybackKind } from './AudioStreamManager.js';

/** Observational only: this event cannot pace output or authorize transmission. */
export interface TxAudioObservation {
  transmissionId: string;
  streamGeneration: number;
  kind: PlaybackKind;
  phase: 'started' | 'samples' | 'completed' | 'interrupted';
  timestampMs: number;
  sampleOffset: number;
  sampleRate: number;
  stage: 'submitted' | 'consumed';
  samples?: Float32Array;
  error?: string;
}
