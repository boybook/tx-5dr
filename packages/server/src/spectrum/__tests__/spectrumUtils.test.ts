import { describe, expect, it } from 'vitest';
import type { IcomScopeFrame } from 'icom-wlan-node';
import type { SpectrumLine } from 'hamlib/spectrum';
import {
  createHamlibRadioSpectrumFrame,
  createRadioSpectrumFrame,
} from '../spectrumUtils.js';

function decode(frame: ReturnType<typeof createRadioSpectrumFrame>): number[] {
  const bytes = Buffer.from(frame.binaryData.data, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scale = frame.binaryData.format.scale ?? 1;
  const offset = frame.binaryData.format.offset ?? 0;
  return Array.from({ length: frame.binaryData.format.length }, (_, index) => (
    view.getInt16(index * 2, true) * scale + offset
  ));
}

describe('spectrum level normalization', () => {
  it('marks direct ICOM WLAN scope bytes as raw Level values', () => {
    const frame = createRadioSpectrumFrame({
      startFreqHz: 7_000_000,
      endFreqHz: 7_100_000,
      pixels: Uint8Array.from([0, 128, 255]),
    } as unknown as IcomScopeFrame, null, 'ICOM WLAN');

    expect(frame.meta.level).toEqual({
      domain: 'raw',
      unit: 'Level',
      reference: 'none',
      calibrated: false,
      min: 0,
      max: 255,
    });
    expect(frame.binaryData.format.scale).toBe(1);
    expect(decode(frame)[0]).toBe(0);
    expect(decode(frame).at(-1)).toBe(255);
  });

  it('maps calibrated Hamlib bytes into device dB values', () => {
    const frame = createHamlibRadioSpectrumFrame({
      scopeId: 0,
      dataLevelMin: 0,
      dataLevelMax: 255,
      signalStrengthMin: -120,
      signalStrengthMax: 0,
      mode: 1,
      centerFreq: 7_050_000,
      spanHz: 100_000,
      lowEdgeFreq: 7_000_000,
      highEdgeFreq: 7_100_000,
      dataLength: 3,
      data: Buffer.from([0, 128, 255]),
      timestamp: 1,
    } as SpectrumLine, null, 'ICOM Serial (Hamlib)');

    expect(frame.meta.level).toEqual({
      domain: 'calibrated-db',
      unit: 'dB',
      reference: 'device',
      calibrated: true,
      min: -120,
      max: 0,
    });
    expect(frame.binaryData.format.scale).toBe(0.01);
    const values = decode(frame);
    expect(values[0]).toBeCloseTo(-120, 1);
    expect(values.at(-1)).toBeCloseTo(0, 1);
  });

  it('falls back to raw Level values when Hamlib calibration is invalid', () => {
    const frame = createHamlibRadioSpectrumFrame({
      scopeId: 0,
      dataLevelMin: 255,
      dataLevelMax: 0,
      signalStrengthMin: -120,
      signalStrengthMax: 0,
      mode: 1,
      centerFreq: 7_050_000,
      spanHz: 100_000,
      lowEdgeFreq: 7_000_000,
      highEdgeFreq: 7_100_000,
      dataLength: 2,
      data: Buffer.from([12, 200]),
      timestamp: 1,
    } as SpectrumLine, null, 'ICOM Serial (Hamlib)');

    expect(frame.meta.level?.domain).toBe('raw');
    expect(frame.binaryData.format.scale).toBe(1);
  });
});
