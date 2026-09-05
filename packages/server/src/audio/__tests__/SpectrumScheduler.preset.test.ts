import { describe, expect, it, vi } from 'vitest';
import { SpectrumScheduler } from '../SpectrumScheduler.js';

describe('SpectrumScheduler presets', () => {
  it('exposes balanced as the default render contract', () => {
    const scheduler = new SpectrumScheduler();
    const config = scheduler.getRenderConfig();

    expect(config).toMatchObject({
      preset: 'balanced',
      revision: 0,
      analysisIntervalMs: 150,
      fftSize: 8192,
      targetSampleRate: 6000,
      displayBinCount: 4097,
    });
    expect(config.fftWindowDurationMs).toBeCloseTo(1365.333, 2);
    expect(config.frequencyResolutionHz).toBeCloseTo(0.732421875, 9);
  });

  it('applies a preset without requiring the audio engine to restart', () => {
    const scheduler = new SpectrumScheduler();
    const configChanged = vi.fn();
    scheduler.on('configChanged', configChanged);

    scheduler.applyPreset('responsive', 7);
    scheduler.emitConfigChanged();

    expect(scheduler.getConfig()).toMatchObject({
      analysisInterval: 100,
      fftSize: 2048,
      targetSampleRate: 6000,
      configRevision: 7,
    });
    expect(scheduler.getRenderConfig()).toMatchObject({
      preset: 'responsive',
      revision: 7,
      displayBinCount: 1025,
    });
    expect(configChanged).toHaveBeenCalledTimes(1);
  });

  it('provides the slow block preset for cross-cycle waterfall viewing', () => {
    const scheduler = new SpectrumScheduler();
    scheduler.applyPreset('block', 3);

    expect(scheduler.getRenderConfig()).toMatchObject({
      preset: 'block',
      revision: 3,
      analysisIntervalMs: 600,
      frameRateHz: 1000 / 600,
      fftSize: 8192,
      frequencyResolutionHz: 6000 / 8192,
    });
  });

  it('keeps IF display tuning while changing the analysis preset', () => {
    const scheduler = new SpectrumScheduler();
    scheduler.setInputSignalType('icom-12k-if');
    scheduler.applyPreset('fine', 2);

    expect(scheduler.getRenderConfig()).toMatchObject({
      preset: 'fine',
      fftSize: 16384,
      windowFunction: 'blackmanHarris',
      haloReduce: true,
      displayBinCount: 8193,
    });
  });

  it('applies and exposes fully custom analysis settings', () => {
    const scheduler = new SpectrumScheduler();
    scheduler.applyPreset('custom', 4, {
      analysisIntervalMs: 275,
      fftSize: 4096,
      targetSampleRate: 8000,
      windowFunction: 'hann',
      haloReduce: true,
    });

    expect(scheduler.getRenderConfig()).toMatchObject({
      preset: 'custom',
      revision: 4,
      analysisIntervalMs: 275,
      frameRateHz: 1000 / 275,
      fftSize: 4096,
      targetSampleRate: 8000,
      fftWindowDurationMs: 512,
      frequencyResolutionHz: 8000 / 4096,
      frequencyRange: { min: 0, max: 4000 },
      displayBinCount: 2049,
      windowFunction: 'hann',
      haloReduce: true,
      customSettings: {
        analysisIntervalMs: 275,
        fftSize: 4096,
        targetSampleRate: 8000,
        windowFunction: 'hann',
        haloReduce: true,
      },
    });
  });
});
