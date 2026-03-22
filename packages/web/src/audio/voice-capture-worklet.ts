/**
 * Voice Capture AudioWorklet Processor
 *
 * Runs in a separate audio thread, capturing microphone PCM samples
 * and posting them to the main thread for Opus encoding and WS transmission.
 *
 * Message protocol (main -> worklet):
 *   { type: 'start' }  - begin forwarding audio frames
 *   { type: 'stop' }   - stop forwarding audio frames
 *
 * Message protocol (worklet -> main):
 *   { type: 'pcmFrame', data: Float32Array }  - 128-sample PCM frame
 */

// AudioWorklet global types (not available in normal TypeScript context)
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private active = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'start') {
        this.active = true;
      } else if (event.data.type === 'stop') {
        this.active = false;
      }
    };
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    if (!this.active) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Take first channel (mono)
    const channelData = input[0];
    if (!channelData || channelData.length === 0) return true;

    // Send a copy of the PCM data to the main thread
    const copy = new Float32Array(channelData.length);
    copy.set(channelData);
    this.port.postMessage({ type: 'pcmFrame', data: copy }, [copy.buffer]);

    return true;
  }
}

registerProcessor('voice-capture-processor', VoiceCaptureProcessor);
