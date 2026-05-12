import { describe, expect, it } from 'vitest';
import {
  DEEP_CW_BIN_RESOLUTION,
  DEEP_CW_CROPPED_BINS,
  DEEP_CW_DECODABLE_MAX_FREQ_HZ,
  DEEP_CW_DECODABLE_MIN_FREQ_HZ,
  DEEP_CW_FFT_LENGTH,
  DEEP_CW_HOP_LENGTH,
  DEEP_CW_SAMPLE_RATE,
  getDeepCWBandMapping,
} from '../DeepCWFeatureExtractor.js';

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
});
