import { expect, it } from 'vitest';
import { WSJTXDecodeProcessPool } from '../WSJTXDecodeProcessPool.js';
import type { DecodeRequest } from '@tx5dr/contracts';

// Real child-process IPC and wsjtx-lib, with silence only: never opens a radio.
it('reuses a native worker across repeated FT8/FT4 session cancellations', async () => {
  const pool = new WSJTXDecodeProcessPool({ workerCount: 1 });
  const pcm = new Float32Array(180_000).buffer;
  try {
    for (const mode of ['FT8', 'FT4'] as const) {
      for (let i = 0; i < 2; i++) {
        const id = `native-${mode}-${i}`;
        const request: DecodeRequest = {
          slotId: id, decodeSessionId: id, decodeDepth: 3, decodeStage: mode === 'FT8' ? 41 : 'ft4-partial',
          decodeFinalWindow: false, windowIdx: 0, mode, pcm, timestamp: Date.now(), windowOffsetMs: -1500, sampleRate: 12000,
        };
        await pool.decode(request);
        pool.cancelSession(id, 'transmit-skipped');
        const next = await pool.decode({ ...request, slotId: `${id}-next`, decodeSessionId: `${id}-next`,
          decodeStage: mode === 'FT8' ? 50 : 'ft4-final', decodeFinalWindow: true, windowIdx: 2 });
        expect(next.slotId).toBe(`${id}-next`);
        expect(pool.getStatus()).toMatchObject({ status: 'ready', queueSize: 0, restartAttempts: 0 });
      }
    }
  } finally { await pool.destroy(); }
}, 60_000);
