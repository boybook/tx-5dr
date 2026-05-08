import { describe, expect, it, vi } from 'vitest';
import type { EncodeRequest, EncodeResult } from '../WSJTXEncodeWorkQueue.js';

const encodeResponses = vi.hoisted((): Array<{ messageSent: string; audioData?: Float32Array }> => []);
const encodeCalls = vi.hoisted((): Array<{ mode: number; message: string; frequency: number }> => []);

vi.mock('wsjtx-lib', () => {
  const WSJTXMode = {
    FT8: 0,
    FT4: 1,
  };

  class WSJTXLib {
    async encode(mode: number, message: string, frequency: number): Promise<{ audioData: Float32Array; messageSent: string }> {
      encodeCalls.push({ mode, message, frequency });
      const response = encodeResponses.shift() ?? { messageSent: message };
      return {
        audioData: response.audioData ?? new Float32Array(4800).fill(0.1),
        messageSent: response.messageSent,
      };
    }
  }

  return { WSJTXLib, WSJTXMode };
});

import { WSJTXEncodeWorkQueue } from '../WSJTXEncodeWorkQueue.js';

async function encodeOnce(request: Partial<EncodeRequest>, response: { messageSent: string; audioData?: Float32Array }) {
  encodeResponses.length = 0;
  encodeCalls.length = 0;
  encodeResponses.push(response);

  const queue = new WSJTXEncodeWorkQueue(1);
  const complete = new Promise<EncodeResult & { request?: EncodeRequest }>((resolve) => {
    queue.once('encodeComplete', resolve);
  });
  const error = new Promise<{ error: Error; request: EncodeRequest }>((resolve) => {
    queue.once('encodeError', (err, req) => resolve({ error: err, request: req }));
  });

  await queue.push({
    operatorId: 'op-1',
    message: 'CQ BG5DRB OL32',
    frequency: 1500,
    mode: 'FT8',
    ...request,
  });
  await queue.destroy();

  return Promise.race([
    complete.then((result) => ({ type: 'complete' as const, result })),
    error.then((result) => ({ type: 'error' as const, result })),
  ]);
}

describe('WSJTXEncodeWorkQueue messageSent validation', () => {
  it('accepts 23-character structured nonstandard-call messages when the encoder preserves them', async () => {
    const message = '<VA7CD/DU7> BG5DRB RR73';

    const result = await encodeOnce({ message }, { messageSent: `${message}              ` });

    expect(result.type).toBe('complete');
    expect(encodeCalls[0]).toMatchObject({ mode: 0, message, frequency: 1500 });
  });

  it('accepts 13-character free text when the encoder preserves it', async () => {
    const message = '1234567890123';

    const result = await encodeOnce({ message }, { messageSent: `${message}                        ` });

    expect(result.type).toBe('complete');
  });

  it('rejects longer free text when WSJT-X truncates messageSent', async () => {
    const result = await encodeOnce(
      { message: 'THIS IS CUSTOM TEXT' },
      { messageSent: 'THIS IS CUSTO                        ' },
    );

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.result.error.message).toContain('encoder changed message text');
      expect(result.result.error.message).toContain('Free text messages are limited to 13 characters');
    }
  });

  it('tracks queued work and emits queueEmpty after encode completion', async () => {
    encodeResponses.length = 0;
    encodeCalls.length = 0;
    encodeResponses.push({ messageSent: 'CQ BG5DRB OL32' });

    const queue = new WSJTXEncodeWorkQueue(1);
    const queueEmpty = vi.fn();
    queue.on('queueEmpty', queueEmpty);

    const pushPromise = queue.push({
      operatorId: 'op-1',
      message: 'CQ BG5DRB OL32',
      frequency: 1500,
      mode: 'FT8',
    });

    expect(queue.size()).toBe(1);
    await pushPromise;

    expect(queue.size()).toBe(0);
    expect(queueEmpty).toHaveBeenCalledTimes(1);
    await queue.destroy();
  });
});
