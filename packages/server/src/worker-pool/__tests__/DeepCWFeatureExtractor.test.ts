import { describe, expect, it } from 'vitest';
import {
  DEEP_CW_BIN_RESOLUTION,
  DEEP_CW_CROPPED_BINS,
  DEEP_CW_DECODABLE_MAX_FREQ_HZ,
  DEEP_CW_DECODABLE_MIN_FREQ_HZ,
  DEEP_CW_FFT_LENGTH,
  DEEP_CW_HOP_LENGTH,
  DEEP_CW_SAMPLE_RATE,
  analyzeDeepCWSignal,
  getDeepCWBandMapping,
} from '../DeepCWFeatureExtractor.js';

function sineWave(frequencyHz: number, seconds: number, amplitude = 0.25): Float32Array {
  const samples = new Float32Array(Math.floor(DEEP_CW_SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / DEEP_CW_SAMPLE_RATE);
  }
  return samples;
}

function deterministicNoise(seconds: number, amplitude = 0.1): Float32Array {
  const samples = new Float32Array(Math.floor(DEEP_CW_SAMPLE_RATE * seconds));
  let seed = 0x12345678;
  for (let i = 0; i < samples.length; i += 1) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    samples[i] = (((seed / 0xffffffff) * 2) - 1) * amplitude;
  }
  return samples;
}

describe('DeepCW feature constants', () => {
  it('matches the official Single EN spectrogram geometry', () => {
    expect(DEEP_CW_SAMPLE_RATE).toBe(9_600);
    expect(DEEP_CW_FFT_LENGTH).toBe(768);
    expect(DEEP_CW_HOP_LENGTH).toBe(192);
    expect(DEEP_CW_BIN_RESOLUTION).toBe(12.5);
    expect(DEEP_CW_CROPPED_BINS).toBe(65);
    expect(DEEP_CW_DECODABLE_MIN_FREQ_HZ).toBe(400);
    expect(DEEP_CW_DECODABLE_MAX_FREQ_HZ).toBe(1_200);
  });

  it('maps default target and width to the 400-1200 Hz band', () => {
    expect(getDeepCWBandMapping(800, 800)).toMatchObject({
      targetBin: 64,
      halfWidthBins: 32,
      sourceStartBin: 32,
      sourceEndBin: 96,
      destStartIndex: 0,
      destEndIndex: 64,
      effectiveMinFreqHz: 400,
      effectiveMaxFreqHz: 1_200,
      croppedBins: 65,
    });
  });

  it('maps shifted narrow bands around the target tone only', () => {
    expect(getDeepCWBandMapping(600, 250)).toMatchObject({
      targetBin: 48,
      halfWidthBins: 10,
      sourceStartBin: 38,
      sourceEndBin: 58,
      destStartIndex: 22,
      destEndIndex: 42,
      effectiveMinFreqHz: 475,
      effectiveMaxFreqHz: 725,
    });
  });

  it('detects a strong target tone inside a narrow filter', () => {
    const analysis = analyzeDeepCWSignal(sineWave(800, 3), DEEP_CW_SAMPLE_RATE, 800, 100, 1);

    expect(analysis.classification).toBe('target_tone');
    expect(analysis.peakFreqHz).toBeGreaterThan(790);
    expect(analysis.peakFreqHz).toBeLessThan(810);
    expect(analysis.snrDb).toBeGreaterThan(8);
    expect(analysis.effectiveBandMinHz).toBe(750);
    expect(analysis.effectiveBandMaxHz).toBe(850);
  });

  it('reports a strong tone outside the current narrow filter as off target', () => {
    const analysis = analyzeDeepCWSignal(sineWave(700, 3), DEEP_CW_SAMPLE_RATE, 800, 100, 1);

    expect(analysis.classification).toBe('off_target');
    expect(analysis.peakFreqHz).toBeGreaterThan(690);
    expect(analysis.peakFreqHz).toBeLessThan(710);
    expect(Math.abs(analysis.inBandPeakOffsetHz)).toBeGreaterThan(50);
  });

  it('does not classify broadband noise as a target tone', () => {
    const analysis = analyzeDeepCWSignal(deterministicNoise(3), DEEP_CW_SAMPLE_RATE, 800, 100, 1);

    expect(analysis.classification).not.toBe('target_tone');
  });

  it('classifies all-zero input as silence', () => {
    const analysis = analyzeDeepCWSignal(new Float32Array(DEEP_CW_SAMPLE_RATE * 3), DEEP_CW_SAMPLE_RATE, 800, 800, 1);

    expect(analysis.classification).toBe('silence');
    expect(analysis.rmsDbfs).toBeLessThan(-70);
    expect(analysis.effectiveBandMinHz).toBe(400);
    expect(analysis.effectiveBandMaxHz).toBe(1_200);
  });
});
