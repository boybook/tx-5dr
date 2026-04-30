export interface VoiceTxOutputSinkState {
  available: boolean;
  kind: 'rtaudio' | 'icom-wlan';
  outputSampleRate: number;
  outputBufferSize: number;
}
