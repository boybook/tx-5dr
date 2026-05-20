export interface VoiceTxOutputSinkState {
  available: boolean;
  kind: 'rtaudio' | 'icom-wlan' | 'android';
  outputSampleRate: number;
  outputBufferSize: number;
}
