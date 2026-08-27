import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT8MessageType } from '@tx5dr/contracts';
import { FT8MessageParser } from '../src/parser/ft8-message-parser';
import { isUndecodedCallsignPlaceholder, isCallableCallsign } from '../src/callsign/callsign';

test('FT8 partial-decode `<...>` messages parse to UNKNOWN (not a real callsign)', () => {
  const messages = [
    'BG5DRB <...> RR73',
    'BG5DRB <...> -01',
    'CQ <...> PL09',
    '<...> BG5DRB 73',
  ];

  for (const raw of messages) {
    const parsed = FT8MessageParser.parseMessage(raw);
    assert.equal(parsed.type, FT8MessageType.UNKNOWN, `expected UNKNOWN for "${raw}"`);
    assert.equal('senderCallsign' in parsed, false, `"${raw}" must not expose senderCallsign`);
    assert.equal('targetCallsign' in parsed, false, `"${raw}" must not expose targetCallsign`);
  }
});

test('FT8 Fox/Hound RR73 with a real Fox hash still parses (regression)', () => {
  const parsed = FT8MessageParser.parseMessage('BG5BNW RR73; RY3PAG <EX7CQ> -20');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.senderCallsign, 'EX7CQ');
  assert.equal(parsed.completedCallsign, 'BG5BNW');
  assert.equal(parsed.nextCallsign, 'RY3PAG');
  assert.equal(parsed.foxHash, 'EX7CQ');
});

test('FT8 Fox/Hound RR73 with an undecoded hash placeholder keeps type but no sender identity', () => {
  const parsed = FT8MessageParser.parseMessage('BG5BNW RR73; RY3PAG <...> -20');

  assert.equal(parsed.type, FT8MessageType.FOX_RR73);
  assert.equal(parsed.completedCallsign, 'BG5BNW');
  assert.equal(parsed.nextCallsign, 'RY3PAG');
  assert.equal(parsed.foxHash, '...');
  assert.equal('senderCallsign' in parsed, false);
});

test('isUndecodedCallsignPlaceholder detects `<...>` and `...` only', () => {
  assert.equal(isUndecodedCallsignPlaceholder('<...>'), true);
  assert.equal(isUndecodedCallsignPlaceholder('...'), true);
  assert.equal(isUndecodedCallsignPlaceholder('E25XLD/M'), false);
  assert.equal(isUndecodedCallsignPlaceholder('BG5DRB'), false);
  assert.equal(isUndecodedCallsignPlaceholder(''), false);
});

test('FT8MessageParser.rawContainsUndecodedCallsign detects placeholders in raw text', () => {
  assert.equal(FT8MessageParser.rawContainsUndecodedCallsign('CQ <...> PL09'), true);
  assert.equal(FT8MessageParser.rawContainsUndecodedCallsign('BG5DRB <...> RR73'), true);
  assert.equal(FT8MessageParser.rawContainsUndecodedCallsign('BG5DRB E25XLD/M -11'), false);
  assert.equal(FT8MessageParser.rawContainsUndecodedCallsign('CQ BG5DRB OL32'), false);
});

test('parseDecodedSenderCallsign only exposes a decoded sender from supported partial messages', () => {
  const decodedSenderCases: Array<[string, string]> = [
    ['<...> BG5DRB', 'BG5DRB'],
    ['<...> BG5DRB PL09', 'BG5DRB'],
    ['<...> BG5DRB +01', 'BG5DRB'],
    ['<...> BG5DRB R-01', 'BG5DRB'],
    ['<...> BG5DRB RRR', 'BG5DRB'],
    ['<...> BG5DRB RR73', 'BG5DRB'],
    ['... BG5DRB -01', 'BG5DRB'],
    ['<...> <SX100PAOK> 73', 'SX100PAOK'],
    ['<...> E25XLD/M -11', 'E25XLD/M'],
  ];
  const unknownSenderCases = [
    'BG5DRB <...> RR73',
    'BG5DRB <...> -01',
    'CQ <...> PL09',
    '<...> BG5DRB RR73 EXTRA',
    '<...> BG5DRB INVALID',
    '<...> BG5DRB R12',
    '<...> <THANKS> 73',
    'TNX BG5DRB 73',
    'BG5BNW RR73; RY3PAG <...> -20',
    'JA0OAV RR73; JG1MPG <4>',
  ];

  for (const [raw, expected] of decodedSenderCases) {
    assert.equal(FT8MessageParser.parseDecodedSenderCallsign(raw), expected, raw);
  }

  for (const raw of unknownSenderCases) {
    assert.equal(FT8MessageParser.parseDecodedSenderCallsign(raw), undefined, raw);
  }
});

test('parseDecodedSenderCallsign preserves structured sender parsing', () => {
  assert.equal(FT8MessageParser.parseDecodedSenderCallsign('CQ EU BG2LNA PN42'), 'BG2LNA');
  assert.equal(FT8MessageParser.parseDecodedSenderCallsign('CQ 290 K1ABC FN42'), 'K1ABC');
  assert.equal(FT8MessageParser.parseDecodedSenderCallsign('CQ SX100PAOK KM18'), 'SX100PAOK');
  assert.equal(
    FT8MessageParser.parseDecodedSenderCallsign('BG5BNW RR73; RY3PAG <EX7CQ> -20'),
    'EX7CQ',
  );
});

test('isCallableCallsign excludes placeholders but keeps real callsigns', () => {
  assert.equal(isCallableCallsign('BG5DRB'), true);
  assert.equal(isCallableCallsign('E25XLD/M'), true);
  assert.equal(isCallableCallsign('...'), false);
  assert.equal(isCallableCallsign('<...>'), false);
  assert.equal(isCallableCallsign(''), false);
});
