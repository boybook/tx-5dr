import { describe, expect, it, vi } from 'vitest';

// Characterization of ft8-lessons TX-04 (same lesson as DEC-10): wsjtx-lib
// keeps process-wide static state, so every in-process native call (encode and
// message preflight) runs one at a time through WSJTXNativeGate. Describes
// current behavior; does not change it.

const native = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  order: [] as string[],
  releases: [] as Array<() => void>,
}));

vi.mock('wsjtx-lib', () => {
  const WSJTXMode = { FT8: 0, FT4: 1 };

  class WSJTXLib {
    async encode(_mode: number, message: string, _frequency: number) {
      native.active += 1;
      native.maxActive = Math.max(native.maxActive, native.active);
      native.order.push(`start ${message}`);
      await new Promise<void>((resolve) => native.releases.push(resolve));
      native.order.push(`end ${message}`);
      native.active -= 1;
      return { audioData: new Float32Array(1_200).fill(0.1), messageSent: message, sampleRate: 12_000 };
    }

    getSampleRate(): number {
      return 12_000;
    }
  }

  return { WSJTXLib, WSJTXMode };
});

import { WSJTXNativeGate } from '../WSJTXNativeGate.js';
import { WSJTXEncodeWorkQueue } from '../WSJTXEncodeWorkQueue.js';
import { DigitalMessagePreflightService } from '../DigitalMessagePreflightService.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Releases native calls one by one until `done` settles. */
async function drainNativeCalls(done: Promise<unknown>): Promise<void> {
  let settled = false;
  void done.finally(() => { settled = true; });
  while (!settled) {
    await flush();
    native.releases.shift()?.();
  }
}

function resetNative(): void {
  native.active = 0;
  native.maxActive = 0;
  native.order.length = 0;
  native.releases.length = 0;
}

describe('TX-04 WSJTXNativeGate', () => {
  it('runs overlapping callers one at a time in arrival order', async () => {
    const log: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    const runs = gates.map((gate, index) => WSJTXNativeGate.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      log.push(`start ${index}`);
      await gate.promise;
      log.push(`end ${index}`);
      active -= 1;
      return index;
    }));

    await flush();
    expect(log).toEqual(['start 0']);
    // Release out of order: later callers still wait for the earlier ones.
    gates[2]!.resolve();
    gates[1]!.resolve();
    await flush();
    expect(log).toEqual(['start 0']);
    gates[0]!.resolve();

    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
    expect(maxActive).toBe(1);
    expect(log).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('releases the gate when an operation throws', async () => {
    const failing = WSJTXNativeGate.run(async () => {
      throw new Error('native failure');
    });
    const next = WSJTXNativeGate.run(async () => 'ran');

    await expect(failing).rejects.toThrow('native failure');
    await expect(next).resolves.toBe('ran');
  });

  it('serializes encode and message preflight across both services', async () => {
    resetNative();
    // Even a queue configured for two concurrent encodes must not overlap native calls.
    const queue = new WSJTXEncodeWorkQueue(2);
    const preflight = new DigitalMessagePreflightService();
    const encoded = new Promise<void>((resolve) => {
      let count = 0;
      queue.on('encodeComplete', () => { count += 1; if (count === 2) resolve(); });
    });

    const work = Promise.all([
      queue.push({ operatorId: 'op-1', message: 'CQ BG5DRB PL09', frequency: 1500, mode: 'FT8' }),
      queue.push({ operatorId: 'op-2', message: 'CQ BG4IAJ OM96', frequency: 1800, mode: 'FT8' }),
      preflight.check({ text: 'JA1AAA BG5DRB -10', mode: 'FT8' }),
      encoded,
    ]);
    await drainNativeCalls(work);
    await queue.destroy();

    expect(native.maxActive).toBe(1);
    expect(native.order).toHaveLength(6);
    for (let i = 0; i < native.order.length; i += 2) {
      // Every start is immediately followed by its own end.
      expect(native.order[i + 1]).toBe(native.order[i]!.replace('start', 'end'));
    }
  });
});
