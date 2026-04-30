const REALTIME_PCM_AUDIO_FRAME_V1_HEADER_BYTES = 20;
const REALTIME_PCM_AUDIO_FRAME_V2_HEADER_BYTES = 24;
const REALTIME_PCM_AUDIO_FRAME_MAGIC = 0x54583544; // TX5D
const REALTIME_PCM_AUDIO_FRAME_VERSION = 1;
const REALTIME_PCM_AUDIO_FRAME_DIAGNOSTICS_VERSION = 2;
const REALTIME_ENCODED_AUDIO_FRAME_HEADER_BYTES = 16;
const REALTIME_ENCODED_AUDIO_FRAME_MAGIC = 0x54583545; // TX5E
const REALTIME_ENCODED_AUDIO_FRAME_DURATION_MS = 20;

export type RealtimeAudioCodec = 'opus' | 'pcm-s16le';

export interface RealtimeEncodedAudioFrame {
  codec: 'opus';
  sequence: number;
  timestampMs: number;
  serverSentAtMs?: number;
  sourceSampleRate: number;
  codecSampleRate: number;
  channels: number;
  samplesPerChannel: number;
  frameDurationMs: number;
  payload: Uint8Array;
}

export type RealtimeAudioFrame = RealtimePcmAudioFrame | RealtimeEncodedAudioFrame;

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

export function getRealtimeEncodedAudioFrameHeaderBytes(): number {
  return REALTIME_ENCODED_AUDIO_FRAME_HEADER_BYTES;
}

export function encodeRealtimeEncodedAudioFrame(frame: RealtimeEncodedAudioFrame): ArrayBuffer {
  const payload = frame.payload instanceof Uint8Array
    ? frame.payload
    : new Uint8Array(frame.payload);
  const buffer = new ArrayBuffer(REALTIME_ENCODED_AUDIO_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);

  view.setUint32(0, REALTIME_ENCODED_AUDIO_FRAME_MAGIC);
  view.setUint8(4, encodeRealtimeAudioCodecId(frame.codec));
  view.setUint8(5, frame.channels);
  view.setUint16(6, frame.codecSampleRate);
  view.setUint32(8, frame.sequence >>> 0);
  view.setUint32(12, frame.timestampMs >>> 0);
  new Uint8Array(buffer, REALTIME_ENCODED_AUDIO_FRAME_HEADER_BYTES).set(payload);
  return buffer;
}

export function decodeRealtimeEncodedAudioFrame(input: ArrayBufferLike): RealtimeEncodedAudioFrame {
  const buffer = input instanceof ArrayBuffer
    ? input
    : input.slice(0) as ArrayBuffer;

  if (buffer.byteLength < REALTIME_ENCODED_AUDIO_FRAME_HEADER_BYTES) {
    throw new Error('Realtime encoded audio frame is too short');
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0);
  if (magic !== REALTIME_ENCODED_AUDIO_FRAME_MAGIC) {
    throw new Error('Realtime encoded audio frame magic mismatch');
  }

  const codec = decodeRealtimeAudioCodecId(view.getUint8(4));
  const channels = view.getUint8(5);
  const codecSampleRate = view.getUint16(6);
  if (channels <= 0 || codecSampleRate <= 0) {
    throw new Error('Realtime encoded audio frame format is invalid');
  }
  const frameDurationMs = REALTIME_ENCODED_AUDIO_FRAME_DURATION_MS;

  return {
    codec,
    sequence: view.getUint32(8),
    timestampMs: view.getUint32(12),
    sourceSampleRate: codecSampleRate,
    codecSampleRate,
    channels,
    samplesPerChannel: Math.round((codecSampleRate * frameDurationMs) / 1000),
    frameDurationMs,
    payload: new Uint8Array(buffer.slice(REALTIME_ENCODED_AUDIO_FRAME_HEADER_BYTES)),
  };
}

export function decodeRealtimeAudioFrame(input: ArrayBufferLike): RealtimeAudioFrame {
  const buffer = input instanceof ArrayBuffer
    ? input
    : input.slice(0) as ArrayBuffer;
  if (buffer.byteLength < 4) {
    throw new Error('Realtime audio frame is too short');
  }
  const magic = new DataView(buffer).getUint32(0);
  if (magic === REALTIME_PCM_AUDIO_FRAME_MAGIC) {
    return decodeRealtimePcmAudioFrame(buffer);
  }
  if (magic === REALTIME_ENCODED_AUDIO_FRAME_MAGIC) {
    return decodeRealtimeEncodedAudioFrame(buffer);
  }
  throw new Error('Realtime audio frame magic mismatch');
}

export function isRealtimeEncodedAudioFrame(frame: RealtimeAudioFrame): frame is RealtimeEncodedAudioFrame {
  return (frame as RealtimeEncodedAudioFrame).codec === 'opus';
}

function encodeRealtimeAudioCodecId(codec: RealtimeEncodedAudioFrame['codec']): number {
  if (codec === 'opus') {
    return 1;
  }
  throw new Error(`Unsupported realtime encoded audio codec: ${codec}`);
}

function decodeRealtimeAudioCodecId(codecId: number): RealtimeEncodedAudioFrame['codec'] {
  if (codecId === 1) {
    return 'opus';
  }
  throw new Error(`Unsupported realtime encoded audio codec id: ${codecId}`);
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
