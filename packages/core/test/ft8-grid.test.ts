import { test } from 'node:test';
import assert from 'node:assert';
import { FT8MessageType } from '@tx5dr/contracts';
import { FT8MessageParser } from '../src/parser/ft8-message-parser';

test('FT8 grid transmission normalization', async (t) => {
  await t.test('CQ messages always use a four-character grid', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.CQ,
      senderCallsign: 'BG5DRB',
      grid: 'PL09AA',
    });

    assert.strictEqual(message, 'CQ BG5DRB PL09');
  });

  await t.test('CALL messages always use a four-character grid', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.CALL,
      senderCallsign: 'BG5DRB',
      targetCallsign: 'BA1ABC',
      grid: 'PL09AA',
    });

    assert.strictEqual(message, 'BA1ABC BG5DRB PL09');
  });
});
