import { describe, expect, it } from 'vitest';
import { parseLine, canonicalName } from '../src/protocol/parser.js';

describe('rigctld parser', () => {
  it('parses short get command', () => {
    const [cmd] = parseLine('f');
    expect(cmd.longName).toBe('get_freq');
    expect(cmd.args).toEqual([]);
    expect(cmd.extended).toBe('none');
  });

  it('parses short set command with arg', () => {
    const [cmd] = parseLine('F 14074000');
    expect(cmd.longName).toBe('set_freq');
    expect(cmd.args).toEqual(['14074000']);
  });

  it('parses long form', () => {
    const [cmd] = parseLine('\\set_freq 14074000');
    expect(cmd.longName).toBe('set_freq');
    expect(cmd.args).toEqual(['14074000']);
  });

  it('parses dump_state', () => {
    const [cmd] = parseLine('\\dump_state');
    expect(cmd.longName).toBe('dump_state');
  });

  it('parses chained short commands', () => {
    const cmds = parseLine('f;F 14074000;m');
    expect(cmds.map((c) => c.longName)).toEqual(['get_freq', 'set_freq', 'get_mode']);
  });

  it('detects extended long-response mode with +', () => {
    const [cmd] = parseLine('+f');
    expect(cmd.extended).toBe('long');
    expect(cmd.longName).toBe('get_freq');
  });

  it('detects extended inline mode with leading ;', () => {
    const [cmd] = parseLine('; f');
    expect(cmd.extended).toBe('inline');
    expect(cmd.longName).toBe('get_freq');
  });

  it('trims CR/LF and empty lines', () => {
    expect(parseLine('')).toEqual([]);
    expect(parseLine('  ')).toEqual([]);
  });

  it('canonicalizes unknown commands as long name', () => {
    expect(canonicalName('\\my_custom').long).toBe('my_custom');
    expect(canonicalName('f').long).toBe('get_freq');
  });
});
