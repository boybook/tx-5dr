import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRealtimePcmAudioFrame,
  decodeWsCompatAudioFrame,
  encodeRealtimePcmAudioFrame,
  encodeWsCompatAudioFrame,
  getRealtimePcmAudioFrameHeaderBytes,
  getWsCompatAudioFrameHeaderBytes,
} from '../wsCompatProtocol.js';

test('realtime PCM frames preserve metadata and payload', () => {
  const pcm = new Int16Array([-32768, -1234, 0, 1234, 32767, 42]);
  const encoded = encodeRealtimePcmAudioFrame({
    sequence: 0xffff_fffe,
    timestampMs: 0x1234_5678,
    sampleRate: 48000,
    channels: 2,
    samplesPerChannel: 3,
    pcm,
  });

  const decoded = decodeRealtimePcmAudioFrame(encoded);
  assert.equal(decoded.sequence, 0xffff_fffe);
  assert.equal(decoded.timestampMs, 0x1234_5678);
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.samplesPerChannel, 3);
  assert.deepEqual(Array.from(decoded.pcm), Array.from(pcm));
});

test('ws-compat protocol exports remain binary-compatible aliases', () => {
  const frame = {
    sequence: 7,
    timestampMs: 123456,
    sampleRate: 12000,
    channels: 1,
    samplesPerChannel: 4,
    pcm: new Int16Array([1, 2, 3, 4]),
  };

  const realtimeEncoded = new Uint8Array(encodeRealtimePcmAudioFrame(frame));
  const compatEncoded = new Uint8Array(encodeWsCompatAudioFrame(frame));

  assert.equal(getWsCompatAudioFrameHeaderBytes(), getRealtimePcmAudioFrameHeaderBytes());
  assert.deepEqual(Array.from(compatEncoded), Array.from(realtimeEncoded));
  assert.deepEqual(
    Array.from(decodeWsCompatAudioFrame(compatEncoded.buffer).pcm),
    Array.from(frame.pcm),
  );
});

test('realtime PCM diagnostics frames preserve server send timestamp', () => {
  const pcm = new Int16Array([10, 20, 30, 40]);
  const encoded = encodeRealtimePcmAudioFrame({
    sequence: 99,
    timestampMs: 0xffff_ff00,
    serverSentAtMs: 0x0000_0020,
    sampleRate: 48000,
    channels: 1,
    samplesPerChannel: 4,
    pcm,
  });

  assert.equal(encoded.byteLength, getRealtimePcmAudioFrameHeaderBytes() + 4 + pcm.byteLength);
  const decoded = decodeRealtimePcmAudioFrame(encoded);
  assert.equal(decoded.timestampMs, 0xffff_ff00);
  assert.equal(decoded.serverSentAtMs, 0x0000_0020);
  assert.deepEqual(Array.from(decoded.pcm), Array.from(pcm));
});
