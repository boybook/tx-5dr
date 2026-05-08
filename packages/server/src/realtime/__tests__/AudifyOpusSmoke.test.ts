import { describe, expect, it } from 'vitest';
import audify from 'audify';

const { OpusDecoder, OpusEncoder } = audify;
const OPUS_APPLICATION_RESTRICTED_LOWDELAY = 2051;

describe('audify Opus native codec', () => {
  it.each([
    [48_000, 960],
    [12_000, 240],
  ])('round-trips 20ms silence at %i Hz', (sampleRate, frameSize) => {
    const encoder = new OpusEncoder(sampleRate, 1, OPUS_APPLICATION_RESTRICTED_LOWDELAY);
    const decoder = new OpusDecoder(sampleRate, 1);
    encoder.bitrate = 32_000;

    const packet = encoder.encode(Buffer.alloc(frameSize * 2), frameSize);
    const decoded = decoder.decode(packet, frameSize);

    expect(packet.length).toBeGreaterThan(0);
    expect(decoded.byteLength).toBe(frameSize * 2);
  });

  it('generates PLC samples from an empty packet', () => {
    const decoder = new OpusDecoder(48_000, 1);
    const decoded = decoder.decode(Buffer.alloc(0), 960);

    expect(decoded.byteLength).toBe(960 * 2);
  });
});
