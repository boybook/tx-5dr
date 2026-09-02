import { describe, expect, it } from 'vitest';
import { SpectrumFrameSchema, SpectrumLevelDescriptorSchema, SpectrumSessionInteractionStateSchema } from '../spectrum.schema.js';
import {
  SpectrumSettingsResponseSchema,
  SpectrumSettingsUpdateRequestSchema,
  TciSpectrumSettingsSchema,
  getSpectrumPresetDefinition,
} from '../spectrum-config.schema.js';

describe('spectrum level descriptor schema', () => {
  it('accepts dBFS, calibrated dB and raw Level descriptors', () => {
    for (const level of [
      { domain: 'dbfs', unit: 'dBFS', reference: 'full-scale', calibrated: true, min: -120, max: 0 },
      { domain: 'calibrated-db', unit: 'dB', reference: 'device', calibrated: true, min: -130, max: 10 },
      { domain: 'raw', unit: 'Level', reference: 'none', calibrated: false, min: 0, max: 255 },
    ]) {
      expect(SpectrumLevelDescriptorSchema.safeParse(level).success).toBe(true);
    }
  });

  it('rejects invalid or non-increasing level ranges', () => {
    expect(SpectrumLevelDescriptorSchema.safeParse({
      domain: 'raw',
      unit: 'dBFS',
      reference: 'none',
      calibrated: false,
      min: 255,
      max: 0,
    }).success).toBe(false);
  });

  it('keeps level optional for old spectrum frames', () => {
    const result = SpectrumFrameSchema.safeParse({
      timestamp: 1,
      kind: 'radio-sdr',
      frequencyRange: { min: 7_000_000, max: 7_100_000 },
      binaryData: {
        data: 'AA==',
        format: { type: 'int16', length: 1 },
      },
      meta: {
        sourceBinCount: 1,
        displayBinCount: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('defaults legacy interaction state to radio-center and accepts split TX targets', () => {
    const interaction = SpectrumSessionInteractionStateSchema.parse({
      showTxMarkers: false,
      showRxMarkers: false,
      canDragTx: false,
      canRightClickSetFrequency: false,
      canDoubleClickSetFrequency: false,
      canDragFrequency: false,
      frequencyGestureTarget: null,
      frequencyStepHz: null,
      presetMarkers: [],
      frequencyOverlays: [{
        id: 'split',
        label: 'TX',
        lineFrequency: 14_052_500,
        rangeStartFrequency: 14_052_500,
        rangeEndFrequency: 14_052_500,
        variant: 'tx',
        draggable: true,
        frequencyTarget: 'split-frequency',
      }],
      canDragVoiceOverlay: false,
      showVoiceOverlay: false,
      canLocalViewportZoom: false,
      canLocalViewportPan: false,
      supportsManualRange: true,
      supportsAutoRange: false,
      defaultRangeMode: 'manual',
    });
    expect(interaction.viewMode).toBe('radio-center');
    expect(interaction.viewport.enabled).toBe(false);
    expect(interaction.frequencyOverlays[0]?.frequencyTarget).toBe('split-frequency');
  });
});

describe('spectrum analysis settings schemas', () => {
  it('validates preset updates and derived render settings', () => {
    expect(SpectrumSettingsUpdateRequestSchema.parse({ preset: 'fine' })).toEqual({ preset: 'fine' });
    const balanced = getSpectrumPresetDefinition('balanced');
    expect(SpectrumSettingsResponseSchema.parse({
      success: true,
      currentSettings: { ...balanced, revision: 3 },
      presets: [getSpectrumPresetDefinition('responsive'), balanced, getSpectrumPresetDefinition('fine')],
    }).currentSettings.displayBinCount).toBe(4097);
  });

  it('rejects arbitrary analysis parameters', () => {
    expect(() => SpectrumSettingsUpdateRequestSchema.parse({ preset: 'custom', fftSize: 4096 })).toThrow();
  });

  it('accepts a validated custom analysis draft', () => {
    expect(SpectrumSettingsUpdateRequestSchema.parse({
      preset: 'custom',
      settings: {
        analysisIntervalMs: 275,
        fftSize: 4096,
        targetSampleRate: 8000,
        windowFunction: 'hann',
        haloReduce: true,
      },
    }).preset).toBe('custom');
  });

  it('accepts high-performance TCI analysis settings within the supported bounds', () => {
    expect(TciSpectrumSettingsSchema.parse({
      fftSize: 65536,
      displayBinCount: 16384,
      analysisIntervalMs: 20,
    })).toEqual({ fftSize: 65536, displayBinCount: 16384, analysisIntervalMs: 20 });
  });
});
