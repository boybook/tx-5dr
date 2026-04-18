import { RigErr, type RigErrCode } from './errors.js';
import type { ExtendedResponseFormat, ParsedCommand } from './parser.js';

/**
 * Rigctld wire format encoder.
 *
 * Three response shapes, each terminated by "\n":
 *   - "value\n" (or multi-line "value1\nvalue2\n") followed by "RPRT N" for
 *     get commands — N is 0 on success, negative on failure.
 *   - "RPRT N\n" alone for set commands.
 *   - Extended mode: each field printed as "Name: value" on its own line,
 *     followed by "RPRT N".
 *
 * A get command that fails returns only "RPRT N" (no value lines).
 */

export interface ResponseField {
  /** Field label used in extended mode. In non-extended mode only `value` is printed. */
  name: string;
  value: string;
}

export interface GetResponse {
  kind: 'get';
  fields: ResponseField[];
}

export interface SetResponse {
  kind: 'set';
}

export interface ErrorResponse {
  kind: 'error';
  code: RigErrCode;
}

export type CommandResponse = GetResponse | SetResponse | ErrorResponse;

export const ok = (): SetResponse => ({ kind: 'set' });
export const err = (code: RigErrCode): ErrorResponse => ({ kind: 'error', code });
export const getOne = (name: string, value: string): GetResponse => ({
  kind: 'get',
  fields: [{ name, value }],
});
export const getFields = (fields: ResponseField[]): GetResponse => ({ kind: 'get', fields });

/** Encode a single command's response into the bytes written to the client. */
export function encodeResponse(cmd: ParsedCommand, res: CommandResponse): string {
  const ext = cmd.extended;

  if (res.kind === 'error') {
    return formatExtendedHeader(cmd, ext) + `RPRT ${res.code}\n`;
  }

  if (res.kind === 'set') {
    return formatExtendedHeader(cmd, ext) + `RPRT 0\n`;
  }

  // GET
  const header = formatExtendedHeader(cmd, ext);
  let body = '';
  if (ext === 'none') {
    body = res.fields.map((f) => `${f.value}\n`).join('');
  } else {
    body = res.fields.map((f) => `${f.name}: ${f.value}\n`).join('');
  }
  return header + body + `RPRT ${RigErr.OK}\n`;
}

/**
 * Extended mode echoes the command name as the first line of the response. We
 * echo the long form with arguments, matching Hamlib rigctld output.
 */
function formatExtendedHeader(cmd: ParsedCommand, ext: ExtendedResponseFormat): string {
  if (ext === 'none') return '';
  const argStr = cmd.args.length ? ` ${cmd.args.join(' ')}` : '';
  return `${cmd.longName ?? cmd.name}:${argStr}\n`;
}
