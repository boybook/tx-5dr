import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT8MessageType } from '@tx5dr/contracts';
import { FT8MessageParser } from '../src/parser/ft8-message-parser';

test('FT8 Fox/Hound RR73 parsing exposes senderCallsign when full Fox callsign is present', () => {
  const parsed = FT8MessageParser.parseMessage('BG5BNW RR73; RY3PAG <EX7CQ> -20');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.senderCallsign, 'EX7CQ');
  assert.equal(parsed.completedCallsign, 'BG5BNW');
  assert.equal(parsed.nextCallsign, 'RY3PAG');
  assert.equal(parsed.foxHash, 'EX7CQ');
  assert.equal(parsed.snrForNext, -20);
});

test('FT8 Fox/Hound RR73 parsing supports BD4XYR completion sample', () => {
  const parsed = FT8MessageParser.parseMessage('BD4XYR RR73; JH1UBK <EX8ABR> -24');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.senderCallsign, 'EX8ABR');
  assert.equal(parsed.completedCallsign, 'BD4XYR');
  assert.equal(parsed.nextCallsign, 'JH1UBK');
  assert.equal(parsed.foxHash, 'EX8ABR');
  assert.equal(parsed.snrForNext, -24);
});

test('FT8 Fox/Hound RR73 parsing preserves portable Fox callsign suffixes', () => {
  const parsed = FT8MessageParser.parseMessage('BH5HIE RR73; JH5FVT <EX8ABR/P> -14');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.senderCallsign, 'EX8ABR/P');
  assert.equal(parsed.completedCallsign, 'BH5HIE');
  assert.equal(parsed.nextCallsign, 'JH5FVT');
  assert.equal(parsed.foxHash, 'EX8ABR/P');
  assert.equal(parsed.snrForNext, -14);
});

test('FT8 Fox/Hound RR73 parsing tolerates a clipped trailing Fox hash bracket', () => {
  const parsed = FT8MessageParser.parseMessage('BH5HIE RR73; JH5FVT <EX8ABR/P');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.senderCallsign, 'EX8ABR/P');
  assert.equal(parsed.completedCallsign, 'BH5HIE');
  assert.equal(parsed.nextCallsign, 'JH5FVT');
  assert.equal(parsed.foxHash, 'EX8ABR/P');
  assert.equal(parsed.snrForNext, undefined);
});

test('FT8 Fox/Hound RR73 parsing keeps senderCallsign empty when only short hash is present', () => {
  const parsed = FT8MessageParser.parseMessage('JA0OAV RR73; JG1MPG <4>');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.senderCallsign, undefined);
  assert.equal(parsed.completedCallsign, 'JA0OAV');
  assert.equal(parsed.nextCallsign, 'JG1MPG');
  assert.equal(parsed.foxHash, '4');
});
