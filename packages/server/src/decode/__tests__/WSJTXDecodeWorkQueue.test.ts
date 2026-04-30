import { describe, expect, it, vi } from 'vitest';
import type { DecodeRequest, DecodeResult } from '@tx5dr/contracts';

const decodeCalls = vi.hoisted((): Array<{ mode: number; frequency: number; samples: number }> => []);
const pendingMessages = vi.hoisted((): Array<{
  text: string;
  snr: number;
  deltaTime: number;
  deltaFrequency: number;
}> => []);

vi.mock('wsjtx-lib', () => {
  const WSJTXMode = {
    FT8: 0,
    FT4: 1,
  };

  class WSJTXLib {
    async convertAudioFormat(audioData: Float32Array): Promise<Int16Array> {
      return new Int16Array(audioData.length);
    }

    async decode(mode: number, audioData: Int16Array, frequency: number): Promise<{ success: boolean }> {
      decodeCalls.push({ mode, frequency, samples: audioData.length });
      pendingMessages.push({
        text: mode === WSJTXMode.FT4 ? 'CQ DX BH1ABC OM88' : 'CQ DX FT8TEST OM88',
        snr: 10,
        deltaTime: 0.1,
        deltaFrequency: 1000,
      });
      return { success: true };
    }

    pullMessages() {
      return pendingMessages.splice(0);
    }
  }

  return { WSJTXLib, WSJTXMode };
});

import { WSJTXDecodeWorkQueue } from '../WSJTXDecodeWorkQueue.js';

function makePcm(samples = 1200): ArrayBuffer {
  const data = new Float32Array(samples);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

async function decodeOnce(request: DecodeRequest) {
  const queue = new WSJTXDecodeWorkQueue(1);
  const complete = new Promise<DecodeResult>((resolve) => {
    queue.once('decodeComplete', resolve);
  });

  await queue.push(request);
  const result = await complete;
  await queue.destroy();
  return result;
}

describe('WSJTXDecodeWorkQueue mode selection', () => {
  it('uses the FT4 native decoder for FT4 decode requests', async () => {
    decodeCalls.length = 0;
    pendingMessages.length = 0;

    const result = await decodeOnce({
      slotId: 'FT4-0-0',
      mode: 'FT4',
      windowIdx: 1,
      pcm: makePcm(),
      sampleRate: 12000,
      timestamp: Date.now(),
      windowOffsetMs: 0,
    });

    expect(decodeCalls).toEqual([{ mode: 1, frequency: 0, samples: 1200 }]);
    expect(result.frames).toEqual([
      expect.objectContaining({
        message: 'CQ DX BH1ABC OM88',
        freq: 1000,
      }),
    ]);
  });

  it('keeps using the FT8 native decoder for FT8 decode requests', async () => {
    decodeCalls.length = 0;
    pendingMessages.length = 0;

    await decodeOnce({
      slotId: 'FT8-0-0',
      mode: 'FT8',
      windowIdx: 0,
      pcm: makePcm(600),
      sampleRate: 12000,
      timestamp: Date.now(),
      windowOffsetMs: -300,
    });

    expect(decodeCalls).toEqual([{ mode: 0, frequency: 0, samples: 600 }]);
  });
});
