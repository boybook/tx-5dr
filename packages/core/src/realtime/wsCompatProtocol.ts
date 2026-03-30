const WS_COMPAT_AUDIO_FRAME_HEADER_BYTES = 20;
const WS_COMPAT_AUDIO_FRAME_MAGIC = 0x54583544; // TX5D
const WS_COMPAT_AUDIO_FRAME_VERSION = 1;

export interface WsCompatAudioFrame {
  sequence: number;
  timestampMs: number;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  pcm: Int16Array;
}

export function getWsCompatAudioFrameHeaderBytes(): number {
  return WS_COMPAT_AUDIO_FRAME_HEADER_BYTES;
}

export function encodeWsCompatAudioFrame(frame: WsCompatAudioFrame): ArrayBuffer {
  const payloadBytes = frame.pcm.byteLength;
  const buffer = new ArrayBuffer(WS_COMPAT_AUDIO_FRAME_HEADER_BYTES + payloadBytes);
  const view = new DataView(buffer);

  view.setUint32(0, WS_COMPAT_AUDIO_FRAME_MAGIC);
  view.setUint8(4, WS_COMPAT_AUDIO_FRAME_VERSION);
  view.setUint8(5, frame.channels);
  view.setUint16(6, frame.samplesPerChannel);
  view.setUint32(8, frame.sequence);
  view.setUint32(12, frame.timestampMs >>> 0);
  view.setUint32(16, frame.sampleRate);

  new Int16Array(buffer, WS_COMPAT_AUDIO_FRAME_HEADER_BYTES, frame.pcm.length).set(frame.pcm);
  return buffer;
}

export function decodeWsCompatAudioFrame(input: ArrayBufferLike): WsCompatAudioFrame {
  const buffer = input instanceof ArrayBuffer
    ? input
    : input.slice(0) as ArrayBuffer;

  if (buffer.byteLength < WS_COMPAT_AUDIO_FRAME_HEADER_BYTES) {
    throw new Error('WS compat audio frame is too short');
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0);
  if (magic !== WS_COMPAT_AUDIO_FRAME_MAGIC) {
    throw new Error('WS compat audio frame magic mismatch');
  }

  const version = view.getUint8(4);
  if (version !== WS_COMPAT_AUDIO_FRAME_VERSION) {
    throw new Error(`Unsupported WS compat audio frame version: ${version}`);
  }

  const channels = view.getUint8(5);
  const samplesPerChannel = view.getUint16(6);
  const sequence = view.getUint32(8);
  const timestampMs = view.getUint32(12);
  const sampleRate = view.getUint32(16);
  const pcm = new Int16Array(buffer.slice(WS_COMPAT_AUDIO_FRAME_HEADER_BYTES));

  return {
    sequence,
    timestampMs,
    sampleRate,
    channels,
    samplesPerChannel,
    pcm,
  };
}

export function float32ToInt16Pcm(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    output[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return output;
}

export function int16ToFloat32Pcm(samples: Int16Array): Float32Array {
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    output[i] = samples[i]! / 32768;
  }
  return output;
}
