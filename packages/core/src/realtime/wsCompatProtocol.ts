const REALTIME_PCM_AUDIO_FRAME_V1_HEADER_BYTES = 20;
const REALTIME_PCM_AUDIO_FRAME_V2_HEADER_BYTES = 24;
const REALTIME_PCM_AUDIO_FRAME_MAGIC = 0x54583544; // TX5D
const REALTIME_PCM_AUDIO_FRAME_VERSION = 1;
const REALTIME_PCM_AUDIO_FRAME_DIAGNOSTICS_VERSION = 2;

export interface RealtimePcmAudioFrame {
  sequence: number;
  timestampMs: number;
  serverSentAtMs?: number;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  pcm: Int16Array;
}

export type WsCompatAudioFrame = RealtimePcmAudioFrame;

export function getRealtimePcmAudioFrameHeaderBytes(): number {
  return REALTIME_PCM_AUDIO_FRAME_V1_HEADER_BYTES;
}

export function getWsCompatAudioFrameHeaderBytes(): number {
  return getRealtimePcmAudioFrameHeaderBytes();
}

export function encodeRealtimePcmAudioFrame(frame: RealtimePcmAudioFrame): ArrayBuffer {
  const hasDiagnostics = typeof frame.serverSentAtMs === 'number' && Number.isFinite(frame.serverSentAtMs);
  const headerBytes = hasDiagnostics
    ? REALTIME_PCM_AUDIO_FRAME_V2_HEADER_BYTES
    : REALTIME_PCM_AUDIO_FRAME_V1_HEADER_BYTES;
  const payloadBytes = frame.pcm.byteLength;
  const buffer = new ArrayBuffer(headerBytes + payloadBytes);
  const view = new DataView(buffer);

  view.setUint32(0, REALTIME_PCM_AUDIO_FRAME_MAGIC);
  view.setUint8(4, hasDiagnostics ? REALTIME_PCM_AUDIO_FRAME_DIAGNOSTICS_VERSION : REALTIME_PCM_AUDIO_FRAME_VERSION);
  view.setUint8(5, frame.channels);
  view.setUint16(6, frame.samplesPerChannel);
  view.setUint32(8, frame.sequence);
  view.setUint32(12, frame.timestampMs >>> 0);
  view.setUint32(16, frame.sampleRate);
  if (hasDiagnostics) {
    view.setUint32(20, frame.serverSentAtMs! >>> 0);
  }

  new Int16Array(buffer, headerBytes, frame.pcm.length).set(frame.pcm);
  return buffer;
}

export function encodeWsCompatAudioFrame(frame: WsCompatAudioFrame): ArrayBuffer {
  return encodeRealtimePcmAudioFrame(frame);
}

export function decodeRealtimePcmAudioFrame(input: ArrayBufferLike): RealtimePcmAudioFrame {
  const buffer = input instanceof ArrayBuffer
    ? input
    : input.slice(0) as ArrayBuffer;

  if (buffer.byteLength < REALTIME_PCM_AUDIO_FRAME_V1_HEADER_BYTES) {
    throw new Error('Realtime PCM audio frame is too short');
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0);
  if (magic !== REALTIME_PCM_AUDIO_FRAME_MAGIC) {
    throw new Error('Realtime PCM audio frame magic mismatch');
  }

  const version = view.getUint8(4);
  if (version !== REALTIME_PCM_AUDIO_FRAME_VERSION && version !== REALTIME_PCM_AUDIO_FRAME_DIAGNOSTICS_VERSION) {
    throw new Error(`Unsupported realtime PCM audio frame version: ${version}`);
  }
  const headerBytes = version === REALTIME_PCM_AUDIO_FRAME_DIAGNOSTICS_VERSION
    ? REALTIME_PCM_AUDIO_FRAME_V2_HEADER_BYTES
    : REALTIME_PCM_AUDIO_FRAME_V1_HEADER_BYTES;
  if (buffer.byteLength < headerBytes) {
    throw new Error('Realtime PCM audio frame diagnostics header is too short');
  }

  const channels = view.getUint8(5);
  const samplesPerChannel = view.getUint16(6);
  const sequence = view.getUint32(8);
  const timestampMs = view.getUint32(12);
  const sampleRate = view.getUint32(16);
  const serverSentAtMs = version === REALTIME_PCM_AUDIO_FRAME_DIAGNOSTICS_VERSION
    ? view.getUint32(20)
    : undefined;
  const pcm = new Int16Array(buffer.slice(headerBytes));

  return {
    sequence,
    timestampMs,
    serverSentAtMs,
    sampleRate,
    channels,
    samplesPerChannel,
    pcm,
  };
}

export function decodeWsCompatAudioFrame(input: ArrayBufferLike): WsCompatAudioFrame {
  return decodeRealtimePcmAudioFrame(input);
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
