import { EventEmitter } from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import { SlotScheduler, type AudioBufferProvider, type IDecodeQueue } from '@tx5dr/core';
import { FT8_WINDOW_PRESETS, MODES, type DecodeRequest, type SlotInfo } from '@tx5dr/contracts';
import { RingBufferAudioProvider } from '../AudioBufferProvider.js';
import { SpectrumScheduler } from '../SpectrumScheduler.js';

describe('RingBufferAudioProvider clock calibration', () => {
  it('uses the injected calibrated clock when the system clock is one FT8 slot behind', async () => {
    const systemNow = 1_778_592_296_556;
    const ntpOffsetMs = 15_251.6;
    const calibratedNow = systemNow + ntpOffsetMs;
    const provider = new RingBufferAudioProvider(12_000, 60_000, () => calibratedNow);
    const slotStartMs = calibratedNow - 11_800;

    const buffer = await provider.getBuffer(slotStartMs, 11_800);

    expect(buffer.byteLength).toBe(11_800 * 12 * Float32Array.BYTES_PER_ELEMENT);
  });

  it('clamps future slot reads to an empty buffer instead of creating a negative typed array', async () => {
    const loggerWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = new RingBufferAudioProvider(12_000, 60_000, () => 50_000);

      const buffer = await provider.getBuffer(53_444, 11_800);

      expect(buffer.byteLength).toBe(0);
    } finally {
      loggerWarn.mockRestore();
    }
  });
});

describe('SlotScheduler with a calibrated audio provider', () => {
  it('queues all FT8 maximum-preset decode windows under a large NTP offset', async () => {
    const systemNow = 1_778_592_296_556;
    const calibratedNow = systemNow + 15_251.6;
    const provider = new RingBufferAudioProvider(12_000, 60_000, () => calibratedNow);
    const queued: DecodeRequest[] = [];
    const decodeQueue: IDecodeQueue = {
      push(request) {
        queued.push(request);
      },
      size() {
        return queued.length;
      },
    };
    const slotClock = Object.assign(new EventEmitter(), {
      getMode: () => ({
        ...MODES.FT8,
        windowTiming: FT8_WINDOW_PRESETS.maximum,
      }),
    });
    const scheduler = new SlotScheduler(slotClock as never, decodeQueue, provider);
    const slotInfo: SlotInfo = {
      id: 'FT8-118572820-1778592300000',
      startMs: calibratedNow - MODES.FT8.slotMs,
      phaseMs: 0,
      driftMs: 0,
      cycleNumber: 118572820,
      utcSeconds: Math.floor((calibratedNow - MODES.FT8.slotMs) / 1000),
      mode: 'FT8',
    };

    scheduler.start();
    for (let windowIdx = 0; windowIdx < FT8_WINDOW_PRESETS.maximum.length; windowIdx += 1) {
      slotClock.emit('subWindow', slotInfo, windowIdx);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduler.stop();

    expect(queued).toHaveLength(FT8_WINDOW_PRESETS.maximum.length);
    expect(queued.map((request) => request.windowIdx)).toEqual([0, 1, 2, 3, 4]);
    expect(queued.every((request) => request.pcm.byteLength > 0)).toBe(true);
  });
});

describe('SpectrumScheduler with a calibrated audio provider', () => {
  it('uses the audio provider clock for short spectrum reads after NTP offset is applied', async () => {
    const systemNow = 1_779_279_931_310;
    const calibratedNow = systemNow - 543;
    const sampleRate = 12_000;
    const getCurrentTimeMs = vi.fn(() => calibratedNow);
    const getBuffer = vi.fn(async () => new Float32Array(sampleRate).buffer);
    const audioProvider: AudioBufferProvider = {
      getSampleRate: () => sampleRate,
      getCurrentTimeMs,
      getBuffer,
    };
    const scheduler = new SpectrumScheduler({
      analysisInterval: 150,
      fftSize: 2048,
      targetSampleRate: 6000,
      windowFunction: 'hann',
      enabled: true,
    });

    await scheduler.initialize(audioProvider, sampleRate);
    const spectrumReady = new Promise((resolve) => scheduler.once('spectrumReady', resolve));

    try {
      scheduler.start();
      scheduler.setSubscriptionActive(true);

      await spectrumReady;

      expect(getCurrentTimeMs).toHaveBeenCalled();
      expect(getBuffer).toHaveBeenCalledWith(calibratedNow - 150, 150);
      expect(getBuffer).not.toHaveBeenCalledWith(systemNow - 150, 150);
    } finally {
      scheduler.stop();
      await scheduler.destroy();
    }
  });
});
