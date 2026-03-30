class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.frameSamples = 320;
    this.sourceBuffer = new Float32Array(0);
    this.sourceOffset = 0;
  }

  appendInput(input) {
    if (!input || input.length === 0) {
      return;
    }

    const merged = new Float32Array(this.sourceBuffer.length + input.length);
    merged.set(this.sourceBuffer);
    merged.set(input, this.sourceBuffer.length);
    this.sourceBuffer = merged;
  }

  emitFrames() {
    const ratio = sampleRate / this.targetSampleRate;

    while (true) {
      const requiredSamples = Math.ceil(this.sourceOffset + (this.frameSamples * ratio)) + 1;
      if (this.sourceBuffer.length < requiredSamples) {
        return;
      }

      const output = new Int16Array(this.frameSamples);
      for (let i = 0; i < this.frameSamples; i += 1) {
        const sourceIndex = this.sourceOffset + (i * ratio);
        const left = Math.floor(sourceIndex);
        const right = Math.min(left + 1, this.sourceBuffer.length - 1);
        const fraction = sourceIndex - left;
        const leftSample = this.sourceBuffer[left] ?? 0;
        const rightSample = this.sourceBuffer[right] ?? leftSample;
        const sample = leftSample * (1 - fraction) + rightSample * fraction;
        const clamped = Math.max(-1, Math.min(1, sample));
        output[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      }

      this.port.postMessage({
        type: 'audioFrame',
        sampleRate: this.targetSampleRate,
        samplesPerChannel: this.frameSamples,
        buffer: output.buffer,
      }, [output.buffer]);

      const consumedSamples = Math.floor(this.sourceOffset + (this.frameSamples * ratio));
      this.sourceBuffer = this.sourceBuffer.slice(consumedSamples);
      this.sourceOffset = (this.sourceOffset + (this.frameSamples * ratio)) - consumedSamples;
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      this.appendInput(input);
      this.emitFrames();
    }

    return true;
  }
}

registerProcessor('voice-capture-processor', VoiceCaptureProcessor);
