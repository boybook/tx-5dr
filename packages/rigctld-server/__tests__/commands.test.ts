import { describe, expect, it } from 'vitest';
import { dispatchCommand } from '../src/commands/index.js';
import { parseLine } from '../src/protocol/parser.js';
import { RigctldProtocolError, RigErr } from '../src/protocol/errors.js';
import type { RadioController, RigctldIdentity } from '../src/types.js';

const IDENTITY: RigctldIdentity = {
  rigModel: 3073,
  modelName: 'IC-7300',
  mfgName: 'Icom',
  version: 'test',
};

function makeController(overrides: Partial<RadioController> = {}): RadioController {
  return {
    async getFrequency() { return 14_074_000; },
    async setFrequency() {},
    async getMode() { return { mode: 'USB', bandwidthHz: 2400 }; },
    async setMode() {},
    async getPTT() { return false; },
    async setPTT() {},
    ...overrides,
  };
}

async function run(line: string, ctrl: RadioController, readOnly = false): Promise<string> {
  const [cmd] = parseLine(line);
  return dispatchCommand(cmd, { controller: ctrl, identity: IDENTITY, readOnly });
}

describe('rigctld commands', () => {
  it('get_freq returns value + RPRT 0', async () => {
    const out = await run('f', makeController());
    expect(out).toBe('14074000\nRPRT 0\n');
  });

  it('set_freq returns RPRT 0', async () => {
    let captured = 0;
    const out = await run('F 14074000', makeController({ async setFrequency(hz) { captured = hz; } }));
    expect(out).toBe('RPRT 0\n');
    expect(captured).toBe(14_074_000);
  });

  it('get_mode returns two value lines in non-extended mode', async () => {
    const out = await run('m', makeController());
    expect(out).toBe('USB\n2400\nRPRT 0\n');
  });

  it('get_mode in extended mode echoes field names', async () => {
    const out = await run('+m', makeController());
    expect(out).toBe('get_mode:\nMode: USB\nPassband: 2400\nRPRT 0\n');
  });

  it('set_mode accepts mode + bandwidth', async () => {
    let captured: [string, number] = ['', 0];
    const out = await run('M USB 2400', makeController({ async setMode(m, bw) { captured = [m, bw]; } }));
    expect(out).toBe('RPRT 0\n');
    expect(captured).toEqual(['USB', 2400]);
  });

  it('set_ptt maps 0/1 to boolean', async () => {
    let captured: boolean | null = null;
    const c = makeController({ async setPTT(on) { captured = on; } });
    await run('T 1', c);
    expect(captured).toBe(true);
    await run('T 0', c);
    expect(captured).toBe(false);
  });

  it('chk_vfo returns 0 in non-extended mode', async () => {
    const out = await run('\\chk_vfo', makeController());
    expect(out).toBe('0\nRPRT 0\n');
  });

  it('chk_vfo in extended mode echoes field label', async () => {
    const out = await run('+\\chk_vfo', makeController());
    expect(out).toBe('chk_vfo:\nCHKVFO: 0\nRPRT 0\n');
  });

  it('dump_state emits the raw body + RPRT 0 without prefixing "RPRT" lines', async () => {
    const out = await run('\\dump_state', makeController());
    expect(out.endsWith('RPRT 0\n')).toBe(true);
    // Protocol version line is first in the body.
    expect(out.startsWith('0\n')).toBe(true);
    // Rig model second.
    expect(out.split('\n')[1]).toBe('3073');
  });

  it('unknown command returns RPRT -11 (ENIMPL)', async () => {
    const out = await run('\\totally_unknown_cmd', makeController());
    expect(out).toBe(`RPRT ${RigErr.ENIMPL}\n`);
  });

  it('optional command without implementation returns RPRT -11', async () => {
    // getVFO intentionally absent from this controller.
    const out = await run('v', makeController());
    expect(out).toBe(`RPRT ${RigErr.ENIMPL}\n`);
  });

  it('controller throw becomes RPRT -5 (EIO)', async () => {
    const out = await run('f', makeController({
      async getFrequency() { throw new Error('bang'); },
    }));
    expect(out).toBe(`RPRT ${RigErr.EIO}\n`);
  });

  it('RigctldProtocolError throw maps to its code', async () => {
    const out = await run('F notanumber', makeController());
    expect(out).toBe(`RPRT ${RigErr.EINVAL}\n`);
  });

  it('get_level REFUSES unsupported level names', async () => {
    const out = await run('l VOX', makeController({
      async getLevel() { return 0; },
      async setLevel() {},
    }));
    expect(out).toBe(`RPRT ${RigErr.EINVAL}\n`);
  });

  it('get_level RFPOWER returns formatted float', async () => {
    const out = await run('l RFPOWER', makeController({
      async getLevel() { return 0.5; },
    }));
    expect(out).toBe('0.500000\nRPRT 0\n');
  });

  it('set_split_vfo with controller', async () => {
    let captured: { enabled: boolean; txVfo: string } | null = null;
    const out = await run('S 1 VFOB', makeController({
      async setSplit(s) { captured = { enabled: s.enabled, txVfo: s.txVfo }; },
    }));
    expect(out).toBe('RPRT 0\n');
    expect(captured).toEqual({ enabled: true, txVfo: 'VFOB' });
  });

  it('handshake read probes fall back to safe defaults when the controller does not implement them', async () => {
    // Hamlib 4.6+ `rig_open()` probes these getters before any user command.
    // Returning RPRT -11 on a read would trigger a ~20s client-side retry loop
    // and the real command would never be sent. Reads therefore fall back to
    // "feature disabled" defaults when the embedder has not wired the getter —
    // a truthful representation of a capability tx-5dr does not track.
    const c = makeController(); // no lock/rit/xit/ts/ant/dcd implementations
    expect(await run('\\get_lock_mode', c)).toBe('0\nRPRT 0\n');
    expect(await run('\\get_trn', c)).toBe('OFF\nRPRT 0\n');
    expect(await run('\\get_rit', c)).toBe('0\nRPRT 0\n');
    expect(await run('\\get_xit', c)).toBe('0\nRPRT 0\n');
    expect(await run('\\get_ts', c)).toBe('0\nRPRT 0\n');
    expect(await run('\\get_ant', c)).toBe('1\n0\n1\n1\nRPRT 0\n');
    expect(await run('\\get_dcd', c)).toBe('0\nRPRT 0\n');
  });

  it('handshake writes return RIG_ENIMPL when the controller does not implement them (no silent success)', async () => {
    // Writes MUST NOT be silently accepted — clients would assume the feature
    // is honored. When the embedder hasn't wired the setter, return ENIMPL so
    // the client surfaces a real error to the operator.
    const c = makeController();
    expect(await run('\\set_lock_mode 1', c)).toBe(`RPRT ${RigErr.ENIMPL}\n`);
    expect(await run('\\set_trn ON', c)).toBe(`RPRT ${RigErr.ENIMPL}\n`);
    expect(await run('\\set_rit 1000', c)).toBe(`RPRT ${RigErr.ENIMPL}\n`);
    expect(await run('\\set_xit 1000', c)).toBe(`RPRT ${RigErr.ENIMPL}\n`);
    expect(await run('\\set_ts 100', c)).toBe(`RPRT ${RigErr.ENIMPL}\n`);
    expect(await run('\\set_ant 2', c)).toBe(`RPRT ${RigErr.ENIMPL}\n`);
  });

  it('handshake reads use the controller value when implemented', async () => {
    const c = makeController({
      async getLockMode() { return true; },
      async getRit() { return 500; },
      async getXit() { return -250; },
      async getTuningStep() { return 100; },
      async getAntenna() { return { current: 2, rx: 2, tx: 1 }; },
      async getDCD() { return true; },
    });
    expect(await run('\\get_lock_mode', c)).toBe('1\nRPRT 0\n');
    expect(await run('\\get_rit', c)).toBe('500\nRPRT 0\n');
    expect(await run('\\get_xit', c)).toBe('-250\nRPRT 0\n');
    expect(await run('\\get_ts', c)).toBe('100\nRPRT 0\n');
    expect(await run('\\get_ant', c)).toBe('2\n0\n1\n2\nRPRT 0\n');
    expect(await run('\\get_dcd', c)).toBe('1\nRPRT 0\n');
  });

  it('handshake writes invoke the controller when implemented', async () => {
    const captured: Record<string, unknown> = {};
    const c = makeController({
      async setLockMode(v) { captured.lock = v; },
      async setRit(hz) { captured.rit = hz; },
      async setXit(hz) { captured.xit = hz; },
      async setTuningStep(hz) { captured.ts = hz; },
      async setAntenna(n) { captured.ant = n; },
    });
    expect(await run('\\set_lock_mode 1', c)).toBe('RPRT 0\n');
    expect(await run('\\set_rit 500', c)).toBe('RPRT 0\n');
    expect(await run('\\set_xit -250', c)).toBe('RPRT 0\n');
    expect(await run('\\set_ts 100', c)).toBe('RPRT 0\n');
    expect(await run('\\set_ant 2', c)).toBe('RPRT 0\n');
    expect(captured).toEqual({ lock: true, rit: 500, xit: -250, ts: 100, ant: 2 });
  });

  it('read-only mode: every mutating command is rejected with RIG_ENIMPL', async () => {
    let writeInvoked = false;
    const c = makeController({
      async setFrequency() { writeInvoked = true; },
      async setMode() { writeInvoked = true; },
      async setPTT() { writeInvoked = true; },
      async setLockMode() { writeInvoked = true; },
      async setRit() { writeInvoked = true; },
      async setXit() { writeInvoked = true; },
      async setTuningStep() { writeInvoked = true; },
      async setAntenna() { writeInvoked = true; },
      async setPowerStat() { writeInvoked = true; },
      async setSplit() { writeInvoked = true; },
      async setLevel() { writeInvoked = true; },
    });
    const expected = `RPRT ${RigErr.ENIMPL}\n`;
    expect(await run('F 14074000', c, true)).toBe(expected);
    expect(await run('M USB 2400', c, true)).toBe(expected);
    expect(await run('T 1', c, true)).toBe(expected);
    expect(await run('\\set_lock_mode 1', c, true)).toBe(expected);
    expect(await run('\\set_rit 500', c, true)).toBe(expected);
    expect(await run('\\set_xit -500', c, true)).toBe(expected);
    expect(await run('\\set_ts 100', c, true)).toBe(expected);
    expect(await run('\\set_ant 2', c, true)).toBe(expected);
    expect(await run('\\set_powerstat 0', c, true)).toBe(expected);
    expect(await run('S 1 VFOB', c, true)).toBe(expected);
    expect(await run('L RFPOWER 0.5', c, true)).toBe(expected);
    // The controller must never observe a write.
    expect(writeInvoked).toBe(false);
  });

  it('read-only mode: read and handshake-probe commands still work normally', async () => {
    const c = makeController({
      async getLockMode() { return true; },
      async getRit() { return 500; },
    });
    expect(await run('f', c, true)).toBe('14074000\nRPRT 0\n');
    expect(await run('m', c, true)).toBe('USB\n2400\nRPRT 0\n');
    expect(await run('t', c, true)).toBe('0\nRPRT 0\n');
    expect(await run('\\chk_vfo', c, true)).toBe('0\nRPRT 0\n');
    expect(await run('\\get_lock_mode', c, true)).toBe('1\nRPRT 0\n');
    expect(await run('\\get_rit', c, true)).toBe('500\nRPRT 0\n');
    // quit is allowed in read-only mode — it just ends the session.
    expect(await run('q', c, true)).toBe('RPRT 0\n');
  });

  it('explicitly thrown RigctldProtocolError surfaces code', async () => {
    const out = await run('F 14074000', makeController({
      async setFrequency() { throw new RigctldProtocolError(RigErr.EINVAL, 'out of range'); },
    }));
    expect(out).toBe(`RPRT ${RigErr.EINVAL}\n`);
  });
});
