import { describe, expect, it } from 'vitest';
import { encodeCheckpoint } from './encode-checkpoint.js';

describe('checkpoint encoding', () => {
  it('retains JSON semantics and lets timers run during a large checkpoint', async () => {
    const known = new Set(Array.from({ length: 50000 }, (_, i) => `contact-${i}`));
    const checkpoint = { version: 1, target: 'test', known: [],
      receipts: Object.fromEntries([...known].map(key => [key, key])),
      session: { pending: [...known], status: { message: 'quote " and newline\n', missing: undefined } },
    };
    let ticks = 0; const timer = setInterval(() => ticks++, 1);
    try {
      const bytes = await encodeCheckpoint(checkpoint, known);
      expect(JSON.parse(bytes.toString())).toEqual(JSON.parse(JSON.stringify({ ...checkpoint, known: [...known] })));
      expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  });
});
