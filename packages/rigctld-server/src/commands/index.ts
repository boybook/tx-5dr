import type { RigctldIdentity, RadioController } from '../types.js';
import { RigErr, RigctldProtocolError } from '../protocol/errors.js';
import { type CommandResponse, encodeResponse, err, getFields, getOne, ok } from '../protocol/formatter.js';
import type { ParsedCommand } from '../protocol/parser.js';
import { buildDumpState } from '../protocol/dump-state.js';

export interface CommandContext {
  controller: RadioController;
  identity: RigctldIdentity;
  /** When true, handlers tagged as mutators are rejected with RIG_ENIMPL. */
  readOnly?: boolean;
}

type Handler = (cmd: ParsedCommand, ctx: CommandContext) => Promise<CommandResponse>;

/**
 * Long names of every command that would mutate radio state. Kept in one
 * place so the `readOnly` policy is enforced uniformly at the dispatcher,
 * independent of whether the embedder's controller stubs out a setter.
 */
export const WRITE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'set_freq',
  'set_mode',
  'set_vfo',
  'set_ptt',
  'set_split_vfo',
  'set_split_freq',
  'set_split_mode',
  'set_level',
  'set_func',
  'set_parm',
  'set_powerstat',
  'set_lock_mode',
  'set_trn',
  'set_rit',
  'set_xit',
  'set_ts',
  'set_ant',
  'set_rptr_shift',
  'set_rptr_offs',
  'set_ctcss_tone',
  'set_dcs_code',
  'set_ctcss_sql',
  'set_dcs_sql',
  'set_vfo_opt',
  'send_morse',
  'send_voice_mem',
  'stop_morse',
  'send_cmd',
  // VFO memory / bank operations also mutate state.
  'vfo_op',
  'mem_op',
  'set_channel',
  'set_mem',
  'set_bank',
]);

/**
 * Dispatch table keyed by rigctld long command name.
 *
 * Clients may send either short (`F 14074000`) or long (`\set_freq 14074000`)
 * form; the parser normalizes `longName`. Missing entries produce `RPRT -11`.
 */
const HANDLERS: Record<string, Handler> = {
  // --- frequency ---
  get_freq: async (_cmd, { controller }) => {
    const hz = await controller.getFrequency();
    return getOne('Frequency', String(Math.round(hz)));
  },
  set_freq: async (cmd, { controller }) => {
    const hz = parseNumberArg(cmd.args[0]);
    await controller.setFrequency(hz);
    return ok();
  },

  // --- mode ---
  get_mode: async (_cmd, { controller }) => {
    const { mode, bandwidthHz } = await controller.getMode();
    return getFields([
      { name: 'Mode', value: mode },
      { name: 'Passband', value: String(Math.round(bandwidthHz)) },
    ]);
  },
  set_mode: async (cmd, { controller }) => {
    const mode = cmd.args[0];
    if (!mode) throw new RigctldProtocolError(RigErr.EINVAL, 'mode required');
    const bwArg = cmd.args[1];
    // Per rigctld spec, passband 0 means "use current/default". We pass 0
    // straight through; the controller adapter decides how to interpret it.
    const bandwidthHz = bwArg === undefined || bwArg === '' ? 0 : parseNumberArg(bwArg);
    await controller.setMode(mode as never, bandwidthHz);
    return ok();
  },

  // --- VFO ---
  get_vfo: async (_cmd, { controller }) => {
    if (!controller.getVFO) throw new RigctldProtocolError(RigErr.ENIMPL);
    return getOne('VFO', await controller.getVFO());
  },
  set_vfo: async (cmd, { controller }) => {
    if (!controller.setVFO) throw new RigctldProtocolError(RigErr.ENIMPL);
    const v = cmd.args[0];
    if (v !== 'VFOA' && v !== 'VFOB' && v !== 'MEM') {
      throw new RigctldProtocolError(RigErr.EINVAL, 'invalid VFO');
    }
    await controller.setVFO(v);
    return ok();
  },

  // --- PTT ---
  get_ptt: async (_cmd, { controller }) => {
    const on = await controller.getPTT();
    return getOne('PTT', on ? '1' : '0');
  },
  set_ptt: async (cmd, { controller }) => {
    const v = parseNumberArg(cmd.args[0]);
    await controller.setPTT(v !== 0);
    return ok();
  },

  // --- Split ---
  get_split_vfo: async (_cmd, { controller }) => {
    if (!controller.getSplit) throw new RigctldProtocolError(RigErr.ENIMPL);
    const s = await controller.getSplit();
    return getFields([
      { name: 'Split', value: s.enabled ? '1' : '0' },
      { name: 'TX VFO', value: s.txVfo },
    ]);
  },
  set_split_vfo: async (cmd, { controller }) => {
    if (!controller.setSplit) throw new RigctldProtocolError(RigErr.ENIMPL);
    const enabled = parseNumberArg(cmd.args[0]) !== 0;
    const txVfo = cmd.args[1] ?? 'VFOB';
    if (txVfo !== 'VFOA' && txVfo !== 'VFOB') {
      throw new RigctldProtocolError(RigErr.EINVAL, 'invalid TX VFO');
    }
    await controller.setSplit({ enabled, txVfo });
    return ok();
  },
  get_split_freq: async (_cmd, { controller }) => {
    if (!controller.getSplitFreq) throw new RigctldProtocolError(RigErr.ENIMPL);
    return getOne('TX Frequency', String(Math.round(await controller.getSplitFreq())));
  },
  set_split_freq: async (cmd, { controller }) => {
    if (!controller.setSplitFreq) throw new RigctldProtocolError(RigErr.ENIMPL);
    await controller.setSplitFreq(parseNumberArg(cmd.args[0]));
    return ok();
  },
  get_split_mode: async (_cmd, { controller }) => {
    if (!controller.getSplitMode) throw new RigctldProtocolError(RigErr.ENIMPL);
    const m = await controller.getSplitMode();
    return getFields([
      { name: 'TX Mode', value: m.mode },
      { name: 'TX Passband', value: String(Math.round(m.bandwidthHz)) },
    ]);
  },
  set_split_mode: async (cmd, { controller }) => {
    if (!controller.setSplitMode) throw new RigctldProtocolError(RigErr.ENIMPL);
    const mode = cmd.args[0];
    if (!mode) throw new RigctldProtocolError(RigErr.EINVAL, 'mode required');
    const bw = parseNumberArg(cmd.args[1] ?? '0');
    await controller.setSplitMode(mode as never, bw);
    return ok();
  },

  // --- Level ---
  get_level: async (cmd, { controller }) => {
    if (!controller.getLevel) throw new RigctldProtocolError(RigErr.ENIMPL);
    const name = cmd.args[0];
    if (!isSupportedLevel(name)) throw new RigctldProtocolError(RigErr.EINVAL, 'unsupported level');
    const v = await controller.getLevel(name);
    return getOne('Level Value', formatFloat(v));
  },
  set_level: async (cmd, { controller }) => {
    if (!controller.setLevel) throw new RigctldProtocolError(RigErr.ENIMPL);
    const name = cmd.args[0];
    if (!isSupportedLevel(name)) throw new RigctldProtocolError(RigErr.EINVAL, 'unsupported level');
    await controller.setLevel(name, parseNumberArg(cmd.args[1]));
    return ok();
  },

  // --- Power ---
  get_powerstat: async (_cmd, { controller }) => {
    if (!controller.getPowerStat) throw new RigctldProtocolError(RigErr.ENIMPL);
    return getOne('Power Status', (await controller.getPowerStat()) ? '1' : '0');
  },
  set_powerstat: async (cmd, { controller }) => {
    if (!controller.setPowerStat) throw new RigctldProtocolError(RigErr.ENIMPL);
    await controller.setPowerStat(parseNumberArg(cmd.args[0]) !== 0);
    return ok();
  },

  // --- Probes from Hamlib `netrigctl_open()` (4.6+) ---
  //
  // Modern rigctl / WSJT-X / N1MM call `rig_open()` before sending the user's
  // actual command. `rig_open()` probes a fixed set of read-only getters and —
  // crucially — if any of them return `RIG_ENIMPL`, rigctl enters an internal
  // retry loop (up to ~20s on Hamlib 4.6) before giving up WITHOUT sending
  // the real command. So reads MUST return a valid value; writes are allowed
  // to return `RIG_ENIMPL` (the handshake only reads).
  //
  // Strategy per command:
  //   - read:  use `controller.getXxx()` if the embedder implements it,
  //            otherwise fall back to a "feature disabled" default. This is
  //            truthful — the feature really is at its default state in our
  //            abstraction, we just can't observe the physical rig for it.
  //   - write: use `controller.setXxx()` if implemented, otherwise ENIMPL.
  //            Never silently discard a write — that would deceive clients.

  get_lock_mode: async (_cmd, { controller }) => {
    const locked = controller.getLockMode ? await controller.getLockMode() : false;
    return getOne('Locked', locked ? '1' : '0');
  },
  set_lock_mode: async (cmd, { controller }) => {
    if (!controller.setLockMode) throw new RigctldProtocolError(RigErr.ENIMPL);
    await controller.setLockMode(parseNumberArg(cmd.args[0]) !== 0);
    return ok();
  },

  // transceive / async mode updates: tx-5dr never pushes unsolicited state,
  // so this is always "OFF". Writes that try to enable it are honest ENIMPL.
  get_trn: async () => getOne('Transceive', 'OFF'),
  set_trn: async () => {
    throw new RigctldProtocolError(RigErr.ENIMPL);
  },

  get_rit: async (_cmd, { controller }) => {
    const offset = controller.getRit ? await controller.getRit() : 0;
    return getOne('RIT', String(Math.round(offset)));
  },
  set_rit: async (cmd, { controller }) => {
    if (!controller.setRit) throw new RigctldProtocolError(RigErr.ENIMPL);
    await controller.setRit(parseNumberArg(cmd.args[0]));
    return ok();
  },

  get_xit: async (_cmd, { controller }) => {
    const offset = controller.getXit ? await controller.getXit() : 0;
    return getOne('XIT', String(Math.round(offset)));
  },
  set_xit: async (cmd, { controller }) => {
    if (!controller.setXit) throw new RigctldProtocolError(RigErr.ENIMPL);
    await controller.setXit(parseNumberArg(cmd.args[0]));
    return ok();
  },

  get_ts: async (_cmd, { controller }) => {
    const step = controller.getTuningStep ? await controller.getTuningStep() : 0;
    return getOne('Tuning Step', String(Math.round(step)));
  },
  set_ts: async (cmd, { controller }) => {
    if (!controller.setTuningStep) throw new RigctldProtocolError(RigErr.ENIMPL);
    await controller.setTuningStep(parseNumberArg(cmd.args[0]));
    return ok();
  },

  get_ant: async (_cmd, { controller }) => {
    const info = controller.getAntenna
      ? await controller.getAntenna()
      : { current: 1, rx: 1, tx: 1 };
    return getFields([
      { name: 'AntCurr', value: String(info.current) },
      { name: 'Option', value: '0' },
      { name: 'AntTx', value: String(info.tx ?? info.current) },
      { name: 'AntRx', value: String(info.rx ?? info.current) },
    ]);
  },
  set_ant: async (cmd, { controller }) => {
    if (!controller.setAntenna) throw new RigctldProtocolError(RigErr.ENIMPL);
    await controller.setAntenna(parseNumberArg(cmd.args[0]));
    return ok();
  },

  get_dcd: async (_cmd, { controller }) => {
    const dcd = controller.getDCD ? await controller.getDCD() : false;
    return getOne('DCD', dcd ? '1' : '0');
  },

  // --- Info / capability ---
  chk_vfo: async () => getOne('CHKVFO', '0'),
  dump_state: async (_cmd, { identity }) => ({
    kind: 'get',
    // dump_state bypasses the normal fields/encoding — we stash the raw body as
    // a single "value"; the caller post-processes it.
    fields: [{ name: 'DumpState', value: buildDumpState(identity) }],
  }),
  get_info: async (_cmd, { controller, identity }) => {
    const custom = controller.getInfo ? await controller.getInfo().catch(() => null) : null;
    const value = custom ?? `${identity.mfgName} ${identity.modelName} (${identity.version})`;
    return getOne('Info', value);
  },

  // --- Session control ---
  quit: async () => ok(),
};

export async function dispatchCommand(
  cmd: ParsedCommand,
  ctx: CommandContext,
): Promise<string> {
  const canonical = cmd.longName ?? cmd.name;

  // Enforce read-only mode at the dispatcher boundary, *before* calling the
  // handler. This is the authoritative gate — even if future handlers slip a
  // mutation through the controller interface, they can't bypass this check.
  if (ctx.readOnly && WRITE_COMMAND_NAMES.has(canonical)) {
    return encodeResponse(cmd, err(RigErr.ENIMPL));
  }

  const handler = HANDLERS[canonical];
  if (!handler) {
    return encodeResponse(cmd, err(RigErr.ENIMPL));
  }

  let response: CommandResponse;
  try {
    response = await handler(cmd, ctx);
  } catch (e) {
    response = toErrorResponse(e);
  }

  // dump_state's value is a pre-formatted multi-line block; encode specially.
  if (
    (cmd.longName ?? cmd.name) === 'dump_state' &&
    response.kind === 'get'
  ) {
    const body = response.fields[0]?.value ?? '';
    return body + 'RPRT 0\n';
  }

  return encodeResponse(cmd, response);
}

export function isSessionTerminator(cmd: ParsedCommand): boolean {
  return (cmd.longName ?? cmd.name) === 'quit';
}

function parseNumberArg(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    throw new RigctldProtocolError(RigErr.EINVAL, 'argument required');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new RigctldProtocolError(RigErr.EINVAL, 'invalid number');
  }
  return n;
}

const SUPPORTED_LEVELS = new Set(['RFPOWER', 'AF', 'SQL', 'STRENGTH']);
function isSupportedLevel(name: string | undefined): name is 'RFPOWER' | 'AF' | 'SQL' | 'STRENGTH' {
  return typeof name === 'string' && SUPPORTED_LEVELS.has(name);
}

function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return '0.000000';
  return v.toFixed(6);
}

function toErrorResponse(e: unknown): CommandResponse {
  if (e instanceof RigctldProtocolError) return err(e.code);
  return err(RigErr.EIO);
}
