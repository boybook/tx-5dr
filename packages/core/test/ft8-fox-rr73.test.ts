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

test('FT8 Fox/Hound RR73 parsing keeps senderCallsign empty when only short hash is present', () => {
  const parsed = FT8MessageParser.parseMessage('JA0OAV RR73; JG1MPG <4>');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.senderCallsign, undefined);
  assert.equal(parsed.completedCallsign, 'JA0OAV');
  assert.equal(parsed.nextCallsign, 'JG1MPG');
  assert.equal(parsed.foxHash, '4');
});
