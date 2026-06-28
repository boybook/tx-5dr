export interface VoiceTxOutputSinkState {
  available: boolean;
  kind: 'rtaudio' | 'icom-wlan' | 'tci' | 'android';
  outputSampleRate: number;
  outputBufferSize: number;
}
