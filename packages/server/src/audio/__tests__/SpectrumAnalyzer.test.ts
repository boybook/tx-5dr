/**
 * SpectrumAnalyzer unit tests
 */

import { describe, it, expect } from 'vitest';
import { SpectrumAnalyzer } from '../SpectrumAnalyzer.js';

/** Generate a sine wave at the specified frequency */
function generateSineWave(frequency: number, sampleRate: number, duration: number, amplitude = 0.8): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const data = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    data[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  }
  return data;
}

/** Generate silence data */
function generateSilence(sampleRate: number, duration: number): Float32Array {
  return new Float32Array(Math.floor(sampleRate * duration));
}

/** Generate white noise */
function _generateWhiteNoise(sampleRate: number, duration: number, amplitude = 0.1): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const data = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    data[i] = (Math.random() * 2 - 1) * amplitude;
  }
  return data;
}

describe('SpectrumAnalyzer', () => {
  const defaultConfig = {
    sampleRate: 12000,
    fftSize: 2048,
    windowFunction: 'hann' as const,
    targetSampleRate: 6000,
  };

  describe('Constructor', () => {
    it('should create instance normally', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      expect(analyzer).toBeDefined();
    });

    it('should throw error for FFT size not power of 2', () => {
      expect(() => new SpectrumAnalyzer({ ...defaultConfig, fftSize: 1000 }))
        .toThrow('FFT size must be a power of 2');
    });

    it('should use default config values', () => {
      const analyzer = new SpectrumAnalyzer({ sampleRate: 12000, fftSize: 1024 });
      const config = analyzer.getConfig();
      expect(config.windowFunction).toBe('hann');
      expect(config.overlapRatio).toBe(0.5);
      expect(config.targetSampleRate).toBe(6000);
    });
  });

  describe('analyze - basic functionality', () => {
    it('should return valid FT8Spectrum structure', async () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = await analyzer.analyze(audio);

      // Verify structural completeness
      expect(spectrum.timestamp).toBeTypeOf('number');
      expect(spectrum.sampleRate).toBe(defaultConfig.targetSampleRate);
      expect(spectrum.frequencyRange.min).toBe(0);
      expect(spectrum.frequencyRange.max).toBeGreaterThan(0);
      expect(spectrum.binaryData.format.type).toBe('int16');
      expect(spectrum.binaryData.data).toBeTypeOf('string'); // base64
      expect(spectrum.summary!.peakFrequency).toBeTypeOf('number');
      expect(spectrum.summary!.peakMagnitude).toBeTypeOf('number');
      expect(spectrum.summary!.averageMagnitude).toBeTypeOf('number');
    });

    it('should have very low peak amplitude for silent input', async () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const silence = generateSilence(defaultConfig.sampleRate, 0.5);
      const spectrum = await analyzer.analyze(silence);

      expect(spectrum.summary!.peakMagnitude).toBeLessThan(-80);
    });

    it('sine wave peak frequency should be close to input frequency', async () => {
      const targetFreq = 1000; // 1kHz
      // Use sampleRate=targetSampleRate to avoid downsampling zero-padding accuracy impact
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 4096,
        targetSampleRate: 6000,
      });
      const audio = generateSineWave(targetFreq, 6000, 2.0);
      const spectrum = await analyzer.analyze(audio);

      // Frequency resolution = 6000 / 4096 ≈ 1.46Hz, tolerance ±10Hz
      expect(spectrum.summary!.peakFrequency).toBeGreaterThan(targetFreq - 10);
      expect(spectrum.summary!.peakFrequency).toBeLessThan(targetFreq + 10);
    });

    it('sine wave peak amplitude should be significantly higher than silence', async () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const sine = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const silence = generateSilence(defaultConfig.sampleRate, 0.5);

      const specSine = await analyzer.analyze(sine);
      const specSilence = await analyzer.analyze(silence);

      expect(specSine.summary!.peakMagnitude).toBeGreaterThan(specSilence.summary!.peakMagnitude + 30);
    });
  });

  describe('analyze - downsampling', () => {
    it('should skip downsampling when sample rates are equal', async () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 1024,
        targetSampleRate: 6000,
      });
      const audio = generateSineWave(500, 6000, 0.5);
      const spectrum = await analyzer.analyze(audio);

      expect(spectrum.sampleRate).toBe(6000);
      expect(spectrum.frequencyRange.max).toBeLessThanOrEqual(3000);
    });

    it('should correctly downsample high sample rate', async () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 48000,
        fftSize: 2048,
        targetSampleRate: 6000,
      });
      // Use long enough audio to ensure downsampled data is much larger than fftSize
      const audio = generateSineWave(1000, 48000, 2.0);
      const spectrum = await analyzer.analyze(audio);

      expect(spectrum.sampleRate).toBe(6000);
      // Peak frequency after downsampling should still be close to 1kHz, tolerance ±100Hz (linear interpolation downsampling has precision loss)
      expect(spectrum.summary!.peakFrequency).toBeGreaterThan(900);
      expect(spectrum.summary!.peakFrequency).toBeLessThan(1100);
    });
  });

  describe('analyze - window function', () => {
    const windowTypes = ['hann', 'hamming', 'blackman', 'none'] as const;

    it.each(windowTypes)('window function %s should work correctly', async (windowFunction) => {
      const analyzer = new SpectrumAnalyzer({
        ...defaultConfig,
        windowFunction,
      });
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = await analyzer.analyze(audio);

      expect(spectrum.summary!.peakMagnitude).toBeGreaterThan(-60);
      expect(spectrum.binaryData.format.length).toBeGreaterThan(0);
    });
  });

  describe('analyze - binaryData encoding', () => {
    it('base64 data should decode correctly to Int16Array', async () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = await analyzer.analyze(audio);

      const buffer = Buffer.from(spectrum.binaryData.data, 'base64');
      const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);

      expect(int16.length).toBe(spectrum.binaryData.format.length);
    });

    it('should restore dB values using scale/offset', async () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = await analyzer.analyze(audio);

      const buffer = Buffer.from(spectrum.binaryData.data, 'base64');
      const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
      const { scale, offset } = spectrum.binaryData.format;

      // Restore dB values
      const dbValues = Array.from(int16).map(v => v * (scale ?? 1) + (offset ?? 0));
      // dB values should be within reasonable range
      for (const db of dbValues) {
        expect(db).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('analyzeStream - batch analysis', () => {
    it('long audio should return multiple spectrum frames', async () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 1024,
        targetSampleRate: 6000,
        overlapRatio: 0.5,
      });
      // 1s = 6000 samples, fftSize=1024, hopSize=512, expected ~(6000-1024)/512 + 1 ≈ 10 frames
      const audio = generateSineWave(1000, 6000, 1.0);
      const results = await analyzer.analyzeStream(audio);

      expect(results.length).toBeGreaterThan(5);
      results.forEach(spectrum => {
        expect(spectrum.binaryData.format.length).toBeGreaterThan(0);
      });
    });

    it('audio shorter than fftSize should return empty array', async () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 2048,
        targetSampleRate: 6000,
      });
      const shortAudio = new Float32Array(1000); // less than 2048
      const results = await analyzer.analyzeStream(shortAudio);

      expect(results.length).toBe(0);
    });
  });

  describe('updateConfig', () => {
    it('should apply updated window function', async () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      analyzer.updateConfig({ windowFunction: 'blackman' });

      expect(analyzer.getConfig().windowFunction).toBe('blackman');
      // Should still analyze normally
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = await analyzer.analyze(audio);
      expect(spectrum.summary!.peakMagnitude).toBeGreaterThan(-60);
    });

    it('should apply updated FFT size', async () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      analyzer.updateConfig({ fftSize: 4096 });

      expect(analyzer.getConfig().fftSize).toBe(4096);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = await analyzer.analyze(audio);
      expect(spectrum.binaryData.format.length).toBeGreaterThan(0);
    });

    it('should throw error when updating FFT size to non-power-of-2', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      expect(() => analyzer.updateConfig({ fftSize: 3000 }))
        .toThrow('FFT size must be a power of 2');
    });
  });

  describe('frequency resolution', () => {
    it('should distinguish two close but different frequencies', async () => {
      // Use sampleRate=targetSampleRate to avoid downsampling interference
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 8192,
        targetSampleRate: 6000,
      });
      // Frequency resolution = 6000/8192 ≈ 0.73Hz
      const audio800 = generateSineWave(800, 6000, 2.0);
      const audio1000 = generateSineWave(1000, 6000, 2.0);

      const spec800 = await analyzer.analyze(audio800);
      const spec1000 = await analyzer.analyze(audio1000);

      expect(Math.abs(spec800.summary!.peakFrequency - 800)).toBeLessThan(10);
      expect(Math.abs(spec1000.summary!.peakFrequency - 1000)).toBeLessThan(10);
      // The two peak frequencies should be clearly different
      expect(Math.abs(spec800.summary!.peakFrequency - spec1000.summary!.peakFrequency)).toBeGreaterThan(150);
    });
  });
});
