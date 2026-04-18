/**
 * rigctld wire protocol parser.
 *
 * A rigctld session accepts one command per line. Three syntactic forms:
 *   - short:   "f" / "F 14074000" / "M USB 2400"
 *   - long:    "\\get_freq" / "\\set_freq 14074000" / "\\dump_state"
 *   - chain:   "f;F 14074000"  (short form, ';' separator)
 *
 * Extended response mode is toggled per-line with a leading '+' (long-response)
 * or ';' (indented-single-line). Both forms echo field names before values.
 */

export type ExtendedResponseFormat = 'none' | 'long' | 'inline';

export interface ParsedCommand {
  /** Normalized command name: short-char for short form, long name (w/o backslash) otherwise. */
  name: string;
  /** Tokenized args after the command. */
  args: string[];
  /** Raw line as received (for logging), already trimmed. */
  raw: string;
  /** Extended response format requested by the client for THIS command. */
  extended: ExtendedResponseFormat;
  /** Original long name (e.g. `set_freq`) if the command was entered in long form. */
  longName?: string;
}

/**
 * Rigctld command "short name" → "long name" lookup.
 *
 * We only include commands we care about plus a few the client may send; the
 * command dispatcher decides which to actually implement. Unknown commands
 * fall through with name == raw-token (the dispatcher returns ENIMPL).
 */
export const SHORT_TO_LONG: Record<string, string> = {
  f: 'get_freq',
  F: 'set_freq',
  m: 'get_mode',
  M: 'set_mode',
  v: 'get_vfo',
  V: 'set_vfo',
  t: 'get_ptt',
  T: 'set_ptt',
  s: 'get_split_vfo',
  S: 'set_split_vfo',
  i: 'get_split_freq',
  I: 'set_split_freq',
  x: 'get_split_mode',
  X: 'set_split_mode',
  l: 'get_level',
  L: 'set_level',
  u: 'get_func',
  U: 'set_func',
  p: 'get_parm',
  P: 'set_parm',
  g: 'get_rptr_shift',
  G: 'set_rptr_shift',
  '1': 'chk_vfo',
  '2': 'power2mW',
  '3': 'mW2power',
  _: 'get_info',
  w: 'send_cmd',
  q: 'quit',
  Q: 'quit',
};

/** Long → short reverse lookup (generated on first use). */
let LONG_TO_SHORT: Record<string, string> | null = null;
function getLongToShort(): Record<string, string> {
  if (LONG_TO_SHORT) return LONG_TO_SHORT;
  const m: Record<string, string> = {};
  for (const [short, long] of Object.entries(SHORT_TO_LONG)) {
    if (!(long in m)) m[long] = short;
  }
  LONG_TO_SHORT = m;
  return m;
}

/** Resolve any incoming command token to its canonical long name. */
export function canonicalName(token: string): { long: string; short?: string } {
  if (token.startsWith('\\')) {
    const long = token.slice(1);
    return { long, short: getLongToShort()[long] };
  }
  const long = SHORT_TO_LONG[token];
  if (long) return { long, short: token };
  // Unknown — pass through as long name so the dispatcher can decide.
  return { long: token, short: undefined };
}

/**
 * Split a raw input line into one or more commands.
 *
 * Rigctld supports chaining short commands with ';'. Long commands are never
 * chained (a '\\' must start a line of its own). An optional leading '+' or ';'
 * toggles the extended-response format for the whole line.
 */
export function parseLine(line: string): ParsedCommand[] {
  let text = line.trim();
  if (text.length === 0) return [];

  let extended: ExtendedResponseFormat = 'none';
  if (text.startsWith('+')) {
    extended = 'long';
    text = text.slice(1).trimStart();
  } else if (text.startsWith(';')) {
    extended = 'inline';
    text = text.slice(1).trimStart();
  }

  if (text.length === 0) return [];

  // Long form: one command per line, no ';' chaining.
  if (text.startsWith('\\')) {
    return [buildCommand(text, extended)];
  }

  // Short form: may chain with ';'.
  return text
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => buildCommand(chunk, extended));
}

function buildCommand(chunk: string, extended: ExtendedResponseFormat): ParsedCommand {
  // Tokenize on whitespace. Rigctld is not shell-quoted; strings with spaces
  // aren't used by the commands we support.
  const tokens = chunk.split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? '';
  const args = tokens.slice(1);
  const { long, short } = canonicalName(head);
  return {
    name: short ?? long,
    longName: long,
    args,
    raw: chunk,
    extended,
  };
}
