import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDeepCWDecode } from '../CWDecoderWorkerCore.js';

const SAMPLE_RATE = 3_200;
const MODEL_PATH = path.resolve(process.cwd(), '../../resources/models/deepcw/model.onnx');

function makeCqAudio(): Float32Array {
  const unit = 0.1;
  const morse: Record<string, string> = { C: '-.-.', Q: '--.-' };
  const keyed: boolean[] = [];
  for (const [index, letter] of Array.from('CQ').entries()) {
    const code = morse[letter]!;
    for (const [symbolIndex, symbol] of Array.from(code).entries()) {
      keyed.push(...new Array(Math.round((symbol === '-' ? 3 : 1) * unit * SAMPLE_RATE)).fill(true));
      if (symbolIndex !== code.length - 1) {
        keyed.push(...new Array(Math.round(unit * SAMPLE_RATE)).fill(false));
      }
    }
    if (index === 0) keyed.push(...new Array(Math.round(3 * unit * SAMPLE_RATE)).fill(false));
  }

  const audio = new Float32Array(5 * SAMPLE_RATE);
  const start = Math.floor((audio.length - keyed.length) / 2);
  for (let i = 0; i < keyed.length; i += 1) {
    if (!keyed[i]) continue;
    const sampleIndex = start + i;
    if (sampleIndex >= 0 && sampleIndex < audio.length) {
      audio[sampleIndex] = 0.7 * Math.sin((2 * Math.PI * 700 * i) / SAMPLE_RATE);
    }
  }
  return audio;
}

describe('deepcw-engine model', () => {
  it.skipIf(!existsSync(MODEL_PATH))('decodes a synthetic CQ transmission with the pinned model', async () => {
    const result = await runDeepCWDecode({
      id: 1,
      audio: makeCqAudio(),
      sampleRate: SAMPLE_RATE,
      modelPath: MODEL_PATH,
      runtimeBackend: 'cpu',
      language: 'en',
    });

    expect(result.text).toContain('CQ');
    expect(result.confidence).toBeGreaterThan(0.5);
  }, 30_000);
});
