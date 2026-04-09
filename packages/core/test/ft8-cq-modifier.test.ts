import { test } from 'node:test';
import assert from 'node:assert';
import { FT8MessageType } from '@tx5dr/contracts';
import { FT8MessageParser } from '../src/parser/ft8-message-parser';

test('FT8 CQ modifier parsing keeps directed CQ tokens', async (t) => {
  await t.test('parses directed continent CQ modifiers', () => {
    const parsed = FT8MessageParser.parseMessage('CQ EU BG2LNA PN42');
    assert.equal(parsed.type, FT8MessageType.CQ);
    assert.equal(parsed.senderCallsign, 'BG2LNA');
    assert.equal(parsed.flag, 'EU');
    assert.equal(parsed.grid, 'PN42');
  });

  await t.test('parses callback CQ tokens such as 290', () => {
    const parsed = FT8MessageParser.parseMessage('CQ 290 K1ABC FN42');
    assert.equal(parsed.type, FT8MessageType.CQ);
    assert.equal(parsed.senderCallsign, 'K1ABC');
    assert.equal(parsed.flag, '290');
    assert.equal(parsed.grid, 'FN42');
  });

  await t.test('generates CQ messages with modifiers unchanged', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.CQ,
      senderCallsign: 'K1ABC',
      flag: 'DX',
      grid: 'FN42AA',
    });

    assert.equal(message, 'CQ DX K1ABC FN42');
  });
});
