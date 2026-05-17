#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import * as nodeWav from 'node-wav';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';

const SIGNAL_COUNT = 100;
const SLOT_SECONDS = 15;
const PASSBAND_MIN_HZ = 200;
const PASSBAND_MAX_HZ = 3000;
const SAFE_MIN_HZ = 450;
const SAFE_MAX_HZ = 2550;
const FREQUENCY_SLOT_STEP_HZ = 5;
const DEFAULT_SEED = 0x5d8f_2026;
const DEFAULT_OUTPUT_DIR = path.resolve('out', 'ft8-crowded');

const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir ?? DEFAULT_OUTPUT_DIR);
const seed = parseInteger(args.seed, DEFAULT_SEED);
const rng = mulberry32(seed);

const lib = new WSJTXLib({ maxThreads: 4 });
const sampleRate = lib.getSampleRate(WSJTXMode.FT8);
const slotSamples = Math.floor(SLOT_SECONDS * sampleRate);
const noiseRms = 0.0175;

await fs.promises.mkdir(outputDir, { recursive: true });

console.log(`Generating ${SIGNAL_COUNT} FT8 signals via wsjtx-lib at ${sampleRate} Hz`);
console.log(`Seed: ${seed}`);

const frequencyPlan = makeCrowdedFrequencyPlan(SIGNAL_COUNT, rng);
const mix = new Float32Array(slotSamples);
const signals = [];

for (let i = 0; i < SIGNAL_COUNT; i++) {
  const message = makeMessage(i, rng);
  const frequencyHz = Math.round(frequencyPlan[i]);
  const snrDb = randomRange(rng, -20, 8);
  const timeOffsetMs = Math.round(randomRange(rng, -180, 780));

  const encoded = await lib.encode(WSJTXMode.FT8, message, Math.round(frequencyHz), 4);
  const faded = applyPropagationFading(encoded.audioData, sampleRate, rng);
  const signalRms = rms(faded) || 1;
  const targetSignalRms = noiseRms * Math.pow(10, snrDb / 20);
  const gain = targetSignalRms / signalRms;
  const startSample = Math.round((timeOffsetMs / 1000) * sampleRate);

  addToMix(mix, faded, startSample, gain);

  signals.push({
    index: i + 1,
    message: encoded.messageSent.trim(),
    requestedMessage: message,
    frequencyHz,
    timeOffsetMs,
    snrDb: round(snrDb, 1),
    gain: round(gain, 6),
  });

  if ((i + 1) % 10 === 0 || i + 1 === SIGNAL_COUNT) {
    console.log(`Encoded ${i + 1}/${SIGNAL_COUNT}`);
  }
}

const noise = makeUsbReceiverNoise(slotSamples, sampleRate, noiseRms, rng);
for (let i = 0; i < mix.length; i++) {
  mix[i] += noise[i];
}

const peakBefore = peak(mix);
const finalAudio = softLimitAndNormalize(mix, 0.93);
const peakAfter = peak(finalAudio);

const wavPath = path.join(outputDir, `crowded-ft8-100-seed-${seed}.wav`);
const metadataPath = path.join(outputDir, `crowded-ft8-100-seed-${seed}.json`);

const wavBuffer = nodeWav.encode([finalAudio], {
  sampleRate,
  float: true,
  bitDepth: 32,
});

await fs.promises.writeFile(wavPath, wavBuffer);
await fs.promises.writeFile(metadataPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  generator: 'scripts/generate-crowded-ft8.mjs',
  seed,
  mode: 'FT8',
  signalCount: SIGNAL_COUNT,
  sampleRate,
  slotSeconds: SLOT_SECONDS,
  passbandHz: [PASSBAND_MIN_HZ, PASSBAND_MAX_HZ],
  randomFrequencyRangeHz: [SAFE_MIN_HZ, SAFE_MAX_HZ],
  noise: {
    model: 'band-limited USB receiver noise with slight colored hiss',
    rms: noiseRms,
  },
  mix: {
    peakBeforeLimiter: round(peakBefore, 6),
    peakAfterLimiter: round(peakAfter, 6),
    rmsAfterLimiter: round(rms(finalAudio), 6),
  },
  signals,
}, null, 2));

console.log(`WAV: ${wavPath}`);
console.log(`Metadata: ${metadataPath}`);
console.log(`Peak before limiter: ${peakBefore.toFixed(4)}, after: ${peakAfter.toFixed(4)}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output-dir') out.outputDir = argv[++i];
    else if (arg === '--seed') out.seed = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: node scripts/generate-crowded-ft8.mjs [--output-dir DIR] [--seed N]');
      process.exit(0);
    }
  }
  return out;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeCrowdedFrequencyPlan(count, random) {
  const clusters = Array.from({ length: 14 }, () => randomRange(random, SAFE_MIN_HZ + 80, SAFE_MAX_HZ - 80));
  const plan = [];

  for (let i = 0; i < count; i++) {
    const clustered = random() < 0.72;
    const raw = clustered
      ? clusters[Math.floor(random() * clusters.length)] + gaussian(random) * 18
      : randomRange(random, SAFE_MIN_HZ, SAFE_MAX_HZ);
    const bounded = Math.max(SAFE_MIN_HZ, Math.min(SAFE_MAX_HZ, raw));
    plan.push(quantize(bounded, FREQUENCY_SLOT_STEP_HZ));
  }

  return plan.sort((a, b) => a - b);
}

function makeMessage(index, random) {
  const prefixes = ['K', 'N', 'W', 'VE', 'JA', 'DL', 'F', 'G', 'VK', 'ZL', 'LU', 'PY', 'EA', 'I', 'UA', 'YB'];
  const suffixLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const prefix = prefixes[Math.floor(random() * prefixes.length)];
  const digit = Math.floor(random() * 10);
  const suffixLength = random() < 0.82 ? 3 : 2;
  let suffix = '';
  for (let i = 0; i < suffixLength; i++) {
    suffix += suffixLetters[Math.floor(random() * suffixLetters.length)];
  }
  const call = `${prefix}${digit}${suffix}`;
  const grid = makeGrid(index, random);
  return `CQ ${call} ${grid}`;
}

function makeGrid(index, random) {
  const letters = 'ABCDEFGHIJKLMNOPQR';
  const a = letters[(index + Math.floor(random() * 6)) % letters.length];
  const b = letters[Math.floor(random() * letters.length)];
  const c = Math.floor(random() * 10);
  const d = Math.floor(random() * 10);
  return `${a}${b}${c}${d}`;
}

function applyPropagationFading(samples, sr, random) {
  const out = new Float32Array(samples.length);
  const phaseA = randomRange(random, 0, Math.PI * 2);
  const phaseB = randomRange(random, 0, Math.PI * 2);
  const phaseC = randomRange(random, 0, Math.PI * 2);
  const rateA = randomRange(random, 0.035, 0.12);
  const rateB = randomRange(random, 0.16, 0.42);
  const rateC = randomRange(random, 0.65, 1.35);
  const fadeCenter = randomRange(random, 2.0, 11.2);
  const fadeWidth = randomRange(random, 0.35, 1.2);
  const fadeDepth = randomRange(random, 0.0, 0.55);

  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    const slow =
      0.55 * Math.sin(Math.PI * 2 * rateA * t + phaseA) +
      0.28 * Math.sin(Math.PI * 2 * rateB * t + phaseB) +
      0.12 * Math.sin(Math.PI * 2 * rateC * t + phaseC);
    const logFade = Math.exp(slow * 0.78);
    const gaussianDip = 1 - fadeDepth * Math.exp(-0.5 * ((t - fadeCenter) / fadeWidth) ** 2);
    const flutter = 1 + 0.035 * Math.sin(Math.PI * 2 * randomRangeFixed(rateC * 3.7, rateC * 5.2, phaseA) * t + phaseB);
    out[i] = samples[i] * logFade * gaussianDip * flutter;
  }
  return out;
}

function randomRangeFixed(min, max, seedLike) {
  const x = Math.sin(seedLike * 12.9898) * 43758.5453;
  return min + (x - Math.floor(x)) * (max - min);
}

function addToMix(mix, signal, startSample, gain) {
  const signalStart = Math.max(0, -startSample);
  const mixStart = Math.max(0, startSample);
  const available = Math.min(signal.length - signalStart, mix.length - mixStart);
  for (let i = 0; i < available; i++) {
    mix[mixStart + i] += signal[signalStart + i] * gain;
  }
}

function makeUsbReceiverNoise(length, sr, targetRms, random) {
  const white = new Float32Array(length);
  let pink = 0;
  for (let i = 0; i < length; i++) {
    pink = 0.985 * pink + 0.015 * gaussian(random);
    white[i] = 0.76 * gaussian(random) + 1.9 * pink;
  }

  const highPassed = biquadFilter(white, sr, 'highpass', 180, 0.7);
  const bandLimited = biquadFilter(highPassed, sr, 'lowpass', 3300, 0.62);
  const noiseCurrentRms = rms(bandLimited) || 1;
  const scale = targetRms / noiseCurrentRms;

  for (let i = 0; i < bandLimited.length; i++) {
    bandLimited[i] *= scale;
  }
  return bandLimited;
}

function biquadFilter(input, sr, type, freq, q) {
  const omega = 2 * Math.PI * freq / sr;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  }
  a0 = 1 + alpha;
  a1 = -2 * cos;
  a2 = 1 - alpha;

  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;

  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function softLimitAndNormalize(samples, targetPeak) {
  const limited = new Float32Array(samples.length);
  const drive = 1.35;
  for (let i = 0; i < samples.length; i++) {
    limited[i] = Math.tanh(samples[i] * drive) / Math.tanh(drive);
  }

  const p = peak(limited) || 1;
  const gain = Math.min(1, targetPeak / p);
  for (let i = 0; i < limited.length; i++) {
    limited[i] *= gain;
  }
  return limited;
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function peak(samples) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > max) max = value;
  }
  return max;
}

function quantize(value, step) {
  return Math.round(value / step) * step;
}

function randomRange(random, min, max) {
  return min + random() * (max - min);
}

function gaussian(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
