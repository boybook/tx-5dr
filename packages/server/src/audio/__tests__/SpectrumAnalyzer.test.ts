/**
 * SpectrumAnalyzer 单元测试
 */

import { describe, it, expect } from 'vitest';
import { SpectrumAnalyzer } from '../SpectrumAnalyzer.js';

/** 生成指定频率的正弦波 */
function generateSineWave(frequency: number, sampleRate: number, duration: number, amplitude = 0.8): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const data = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    data[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  }
  return data;
}

/** 生成静音数据 */
function generateSilence(sampleRate: number, duration: number): Float32Array {
  return new Float32Array(Math.floor(sampleRate * duration));
}

/** 生成白噪声 */
function generateWhiteNoise(sampleRate: number, duration: number, amplitude = 0.1): Float32Array {
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

  describe('构造函数', () => {
    it('应正常创建实例', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      expect(analyzer).toBeDefined();
    });

    it('FFT 大小非 2 的幂应抛出错误', () => {
      expect(() => new SpectrumAnalyzer({ ...defaultConfig, fftSize: 1000 }))
        .toThrow('FFT size must be a power of 2');
    });

    it('应使用默认配置值', () => {
      const analyzer = new SpectrumAnalyzer({ sampleRate: 12000, fftSize: 1024 });
      const config = analyzer.getConfig();
      expect(config.windowFunction).toBe('hann');
      expect(config.overlapRatio).toBe(0.5);
      expect(config.targetSampleRate).toBe(6000);
    });
  });

  describe('analyze - 基本功能', () => {
    it('应返回有效的 FT8Spectrum 结构', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = analyzer.analyze(audio);

      // 验证结构完整性
      expect(spectrum.timestamp).toBeTypeOf('number');
      expect(spectrum.sampleRate).toBe(defaultConfig.targetSampleRate);
      expect(spectrum.frequencyRange.min).toBe(0);
      expect(spectrum.frequencyRange.max).toBeGreaterThan(0);
      expect(spectrum.binaryData.format.type).toBe('int16');
      expect(spectrum.binaryData.format.length).toBe(defaultConfig.fftSize / 2);
      expect(spectrum.binaryData.data).toBeTypeOf('string'); // base64
      expect(spectrum.summary!.peakFrequency).toBeTypeOf('number');
      expect(spectrum.summary!.peakMagnitude).toBeTypeOf('number');
      expect(spectrum.summary!.averageMagnitude).toBeTypeOf('number');
    });

    it('静音输入的峰值幅度应极低', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const silence = generateSilence(defaultConfig.sampleRate, 0.5);
      const spectrum = analyzer.analyze(silence);

      expect(spectrum.summary!.peakMagnitude).toBeLessThan(-80);
    });

    it('正弦波的峰值频率应接近输入频率', () => {
      const targetFreq = 1000; // 1kHz
      // 使用 sampleRate=targetSampleRate 避免降采样零填充影响精度
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 4096,
        targetSampleRate: 6000,
      });
      const audio = generateSineWave(targetFreq, 6000, 2.0);
      const spectrum = analyzer.analyze(audio);

      // 频率分辨率 = 6000 / 4096 ≈ 1.46Hz，容许误差 ±10Hz
      expect(spectrum.summary!.peakFrequency).toBeGreaterThan(targetFreq - 10);
      expect(spectrum.summary!.peakFrequency).toBeLessThan(targetFreq + 10);
    });

    it('正弦波的峰值幅度应明显高于静音', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const sine = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const silence = generateSilence(defaultConfig.sampleRate, 0.5);

      const specSine = analyzer.analyze(sine);
      const specSilence = analyzer.analyze(silence);

      expect(specSine.summary!.peakMagnitude).toBeGreaterThan(specSilence.summary!.peakMagnitude + 30);
    });
  });

  describe('analyze - 降采样', () => {
    it('采样率相同时应跳过降采样', () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 1024,
        targetSampleRate: 6000,
      });
      const audio = generateSineWave(500, 6000, 0.5);
      const spectrum = analyzer.analyze(audio);

      expect(spectrum.sampleRate).toBe(6000);
      expect(spectrum.frequencyRange.max).toBeLessThanOrEqual(3000);
    });

    it('高采样率应正确降采样', () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 48000,
        fftSize: 2048,
        targetSampleRate: 6000,
      });
      // 使用足够长的音频，确保降采样后数据远大于 fftSize
      const audio = generateSineWave(1000, 48000, 2.0);
      const spectrum = analyzer.analyze(audio);

      expect(spectrum.sampleRate).toBe(6000);
      // 降采样后峰值频率仍应接近 1kHz，容许误差 ±100Hz（线性插值降采样有精度损失）
      expect(spectrum.summary!.peakFrequency).toBeGreaterThan(900);
      expect(spectrum.summary!.peakFrequency).toBeLessThan(1100);
    });
  });

  describe('analyze - 窗口函数', () => {
    const windowTypes = ['hann', 'hamming', 'blackman', 'none'] as const;

    it.each(windowTypes)('窗口函数 %s 应正常工作', (windowFunction) => {
      const analyzer = new SpectrumAnalyzer({
        ...defaultConfig,
        windowFunction,
      });
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = analyzer.analyze(audio);

      expect(spectrum.summary!.peakMagnitude).toBeGreaterThan(-60);
      expect(spectrum.binaryData.format.length).toBeGreaterThan(0);
    });
  });

  describe('analyze - binaryData 编码', () => {
    it('base64 数据应能正确解码为 Int16Array', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = analyzer.analyze(audio);

      const buffer = Buffer.from(spectrum.binaryData.data, 'base64');
      const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);

      expect(int16.length).toBe(spectrum.binaryData.format.length);
      // 所有值应在 Int16 范围内
      for (let i = 0; i < int16.length; i++) {
        expect(int16[i]).toBeGreaterThanOrEqual(0);
        expect(int16[i]).toBeLessThanOrEqual(32767);
      }
    });

    it('使用 scale/offset 应能还原为 dB 值', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = analyzer.analyze(audio);

      const buffer = Buffer.from(spectrum.binaryData.data, 'base64');
      const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
      const { scale, offset } = spectrum.binaryData.format;

      // 还原 dB 值
      const dbValues = Array.from(int16).map(v => v * (scale ?? 1) + (offset ?? 0));
      // dB 值应在合理范围 [-120, 0]
      for (const db of dbValues) {
        expect(db).toBeGreaterThanOrEqual(-121);
        expect(db).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('analyzeStream - 批量分析', () => {
    it('长音频应返回多个频谱帧', () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 1024,
        targetSampleRate: 6000,
        overlapRatio: 0.5,
      });
      // 1秒 = 6000 样本, fftSize=1024, hopSize=512, 预期约 (6000-1024)/512 + 1 ≈ 10 帧
      const audio = generateSineWave(1000, 6000, 1.0);
      const results = analyzer.analyzeStream(audio);

      expect(results.length).toBeGreaterThan(5);
      results.forEach(spectrum => {
        expect(spectrum.binaryData.format.length).toBe(512);
      });
    });

    it('短于 fftSize 的音频应返回空数组', () => {
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 2048,
        targetSampleRate: 6000,
      });
      const shortAudio = new Float32Array(1000); // 少于 2048
      const results = analyzer.analyzeStream(shortAudio);

      expect(results.length).toBe(0);
    });
  });

  describe('updateConfig', () => {
    it('更新窗口函数后应生效', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      analyzer.updateConfig({ windowFunction: 'blackman' });

      expect(analyzer.getConfig().windowFunction).toBe('blackman');
      // 仍能正常分析
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = analyzer.analyze(audio);
      expect(spectrum.summary!.peakMagnitude).toBeGreaterThan(-60);
    });

    it('更新 FFT 大小后应生效', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      analyzer.updateConfig({ fftSize: 4096 });

      expect(analyzer.getConfig().fftSize).toBe(4096);
      const audio = generateSineWave(1000, defaultConfig.sampleRate, 0.5);
      const spectrum = analyzer.analyze(audio);
      // 新 FFT 大小: 4096/2 = 2048 个频率 bin
      expect(spectrum.binaryData.format.length).toBe(2048);
    });

    it('更新 FFT 大小为非 2 的幂应抛出错误', () => {
      const analyzer = new SpectrumAnalyzer(defaultConfig);
      expect(() => analyzer.updateConfig({ fftSize: 3000 }))
        .toThrow('FFT size must be a power of 2');
    });
  });

  describe('频率分辨率', () => {
    it('应能区分两个相近但不同的频率', () => {
      // 使用 sampleRate=targetSampleRate 避免降采样干扰
      const analyzer = new SpectrumAnalyzer({
        sampleRate: 6000,
        fftSize: 8192,
        targetSampleRate: 6000,
      });
      // 频率分辨率 = 6000/8192 ≈ 0.73Hz
      const audio800 = generateSineWave(800, 6000, 2.0);
      const audio1000 = generateSineWave(1000, 6000, 2.0);

      const spec800 = analyzer.analyze(audio800);
      const spec1000 = analyzer.analyze(audio1000);

      expect(Math.abs(spec800.summary!.peakFrequency - 800)).toBeLessThan(10);
      expect(Math.abs(spec1000.summary!.peakFrequency - 1000)).toBeLessThan(10);
      // 两个峰值频率应明显不同
      expect(Math.abs(spec800.summary!.peakFrequency - spec1000.summary!.peakFrequency)).toBeGreaterThan(150);
    });
  });
});
