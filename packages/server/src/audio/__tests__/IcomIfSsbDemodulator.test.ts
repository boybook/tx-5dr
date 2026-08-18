import { describe, expect, it } from 'vitest';
import { IcomIfSsbDemodulator } from '../IcomIfSsbDemodulator.js';

const SAMPLE_RATE = 48000;
const IF_CENTER = 12000;

function synthesizeUsbIfTone(options: {
  audioHz: number;
  amplitude: number;
  durationSec: number;
  sampleRate?: number;
  ifCenterHz?: number;
}): Float32Array {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const ifCenterHz = options.ifCenterHz ?? IF_CENTER;
  const n = Math.floor(sampleRate * options.durationSec);
  const out = new Float32Array(n);
  // Real USB IF: cos(2π (f_if + f_audio) t) — upper sideband tone above IF center.
  const carrierHz = ifCenterHz + options.audioHz;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = options.amplitude * Math.cos(2 * Math.PI * carrierHz * t);
  }
  return out;
}

function rmsInBand(samples: Float32Array, sampleRate: number, toneHz: number, bandwidthHz = 40): number {
  // Goertzel-style power estimate around toneHz.
  const omega = (2 * Math.PI * toneHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  // Normalize roughly by length; bandwidth unused but kept for API clarity.
  void bandwidthHz;
  return Math.sqrt(Math.max(0, power) / samples.length);
}

describe('IcomIfSsbDemodulator', () => {
  it('demodulates a USB IF tone into the expected AF baseband frequency', () => {
    const audioHz = 1000;
    const ifPcm = synthesizeUsbIfTone({ audioHz, amplitude: 0.4, durationSec: 0.25 });
    const demod = new IcomIfSsbDemodulator({ centerHz: IF_CENTER, sideband: 'usb' });
    const af = demod.process(ifPcm, SAMPLE_RATE);

    const toneRms = rmsInBand(af, SAMPLE_RATE, audioHz);
    const offToneRms = rmsInBand(af, SAMPLE_RATE, 2200);
    expect(toneRms).toBeGreaterThan(0.05);
    expect(toneRms).toBeGreaterThan(offToneRms * 4);
  });

  it('keeps a 500 Hz USB IF tone within a few Hz of 500 after demod', () => {
    const audioHz = 500;
    const ifPcm = synthesizeUsbIfTone({ audioHz, amplitude: 0.5, durationSec: 0.5 });
    const demod = new IcomIfSsbDemodulator({ centerHz: IF_CENTER, sideband: 'usb' });
    const af = demod.process(ifPcm, SAMPLE_RATE);

    // Coarse peak search around the expected AF tone (10 Hz steps).
    let bestHz = audioHz;
    let bestRms = 0;
    for (let hz = audioHz - 40; hz <= audioHz + 40; hz += 5) {
      const rms = rmsInBand(af, SAMPLE_RATE, hz);
      if (rms > bestRms) {
        bestRms = rms;
        bestHz = hz;
      }
    }
    expect(bestHz).toBeGreaterThanOrEqual(audioHz - 10);
    expect(bestHz).toBeLessThanOrEqual(audioHz + 10);
    expect(bestRms).toBeGreaterThan(rmsInBand(af, SAMPLE_RATE, 800) * 3);
  });

  it('preserves a weak tone beside a strong IF tone better than raw IF treated as AF', () => {
    const strongHz = 700;
    const weakHz = 1500;
    const strong = synthesizeUsbIfTone({ audioHz: strongHz, amplitude: 0.8, durationSec: 0.3 });
    const weak = synthesizeUsbIfTone({ audioHz: weakHz, amplitude: 0.02, durationSec: 0.3 });
    const mixed = new Float32Array(strong.length);
    for (let i = 0; i < mixed.length; i++) {
      mixed[i] = strong[i] + weak[i];
    }

    const demod = new IcomIfSsbDemodulator({ centerHz: IF_CENTER, sideband: 'usb' });
    const af = demod.process(mixed, SAMPLE_RATE);

    const weakAfterDemod = rmsInBand(af, SAMPLE_RATE, weakHz);
    // Treating IF as AF puts energy near 12k+offset, not at weakHz baseband.
    const weakIfAsAf = rmsInBand(mixed, SAMPLE_RATE, weakHz);
    expect(weakAfterDemod).toBeGreaterThan(0.002);
    expect(weakAfterDemod).toBeGreaterThan(weakIfAsAf * 8);
  });

  it('reconfigures when sample rate or center changes', () => {
    const demod = new IcomIfSsbDemodulator({ centerHz: IF_CENTER });
    const block = synthesizeUsbIfTone({ audioHz: 800, amplitude: 0.3, durationSec: 0.05 });
    const first = demod.process(block, SAMPLE_RATE);
    demod.configure({ centerHz: 11000 });
    const second = demod.process(block, SAMPLE_RATE);
    expect(first.length).toBe(block.length);
    expect(second.length).toBe(block.length);
    // Different LO center must change the demodulated energy at 800 Hz.
    expect(rmsInBand(first, SAMPLE_RATE, 800)).not.toBeCloseTo(rmsInBand(second, SAMPLE_RATE, 800), 3);
  });
});
