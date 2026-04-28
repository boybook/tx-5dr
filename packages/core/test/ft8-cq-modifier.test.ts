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

  await t.test('parses special event long callsigns without treating them as modifiers', () => {
    const parsed = FT8MessageParser.parseMessage('CQ SX100PAOK KM18');
    assert.equal(parsed.type, FT8MessageType.CQ);
    assert.equal(parsed.senderCallsign, 'SX100PAOK');
    assert.equal(parsed.flag, undefined);
    assert.equal(parsed.grid, 'KM18');
  });

  await t.test('keeps activity tokens as CQ modifiers', () => {
    const parsed = FT8MessageParser.parseMessage('CQ POTA K1ABC FN42');
    assert.equal(parsed.type, FT8MessageType.CQ);
    assert.equal(parsed.senderCallsign, 'K1ABC');
    assert.equal(parsed.flag, 'POTA');
    assert.equal(parsed.grid, 'FN42');
  });

  await t.test('does not treat CQ activity words without callsigns as stations', () => {
    const parsed = FT8MessageParser.parseMessage('CQ TEST');
    assert.equal(parsed.type, FT8MessageType.UNKNOWN);
  });

  await t.test('parses bracketed long callsign QSO messages', () => {
    const report = FT8MessageParser.parseMessage('<SX100PAOK> BG5DRB -10');
    assert.equal(report.type, FT8MessageType.SIGNAL_REPORT);
    assert.equal(report.targetCallsign, 'SX100PAOK');
    assert.equal(report.senderCallsign, 'BG5DRB');
    assert.equal(report.report, -10);

    const rrr = FT8MessageParser.parseMessage('<SX100PAOK> BG5DRB RRR');
    assert.equal(rrr.type, FT8MessageType.RRR);
    assert.equal(rrr.targetCallsign, 'SX100PAOK');
    assert.equal(rrr.senderCallsign, 'BG5DRB');

    const seventyThree = FT8MessageParser.parseMessage('<SX100PAOK> BG5DRB 73');
    assert.equal(seventyThree.type, FT8MessageType.SEVENTY_THREE);
    assert.equal(seventyThree.targetCallsign, 'SX100PAOK');
    assert.equal(seventyThree.senderCallsign, 'BG5DRB');
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
