import { describe, expect, it } from 'vitest';

import { PerPathSerialQueue } from '../PerPathSerialQueue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('persistence path coordination', () => {
  it('runs same-path work FIFO, survives failures, and drains the latest operation', async () => {
    const queue = new PerPathSerialQueue();
    const gate = deferred();
    const order: string[] = [];
    const first = queue.run('/tmp/same.adi', async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
    });
    const failed = queue.run('/tmp/same.adi', async () => {
      order.push('failed');
      throw new Error('expected failure');
    });
    const third = queue.run('/tmp/same.adi', async () => {
      order.push('third');
    });
    const drained = queue.drain('/tmp/same.adi').then(() => order.push('drained'));

    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual(['first-start']);
    gate.resolve();
    await expect(failed).rejects.toThrow('expected failure');
    await Promise.all([first, third, drained]);
    expect(order).toEqual(['first-start', 'first-end', 'failed', 'third', 'drained']);
  });

});
