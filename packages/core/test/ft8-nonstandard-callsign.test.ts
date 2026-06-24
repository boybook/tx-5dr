import { test } from 'node:test';
import assert from 'node:assert';
import { FT8MessageType } from '@tx5dr/contracts';
import { FT8MessageParser } from '../src/parser/ft8-message-parser';

// FT8 Type 1/2 仅支持 /R (Type 1) 与 /P (Type 2) 后缀；
// /M /MM /AM /QRP /1 等均为非标准呼号，必须用 <...> 包裹走 Type 4，
// 否则 wsjtx-lib pack77 会用 base call 按 Type 1 编码、丢弃后缀。
// 对齐上游 WSJT-X stdCall 的 (\/R|\/P)? 规则。

test('isStandardCallsign classifies suffixes per FT8 Type 1/2 support', () => {
  const standard = ['E25XLD', 'BA8BLK', 'BG5DRB', '4U1ITU', 'E25XLD/P', 'E25XLD/R'];
  const nonstandard = [
    'E25XLD/M',
    'E25XLD/MM',
    'E25XLD/AM',
    'E25XLD/QRP',
    'E25XLD/1',
    'E25XLD/2',
    'BG7KEO/QRP',
    'WB9XYZ/A',
  ];

  for (const callsign of standard) {
    assert.ok(FT8MessageParser.isStandardCallsign(callsign), `${callsign} 应为标准呼号`);
  }
  for (const callsign of nonstandard) {
    assert.ok(!FT8MessageParser.isStandardCallsign(callsign), `${callsign} 应为非标准呼号`);
  }
});

test('generateMessage wraps nonstandard callsigns with <> for Type 4', async (t) => {
  await t.test('SIGNAL_REPORT', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.SIGNAL_REPORT,
      senderCallsign: 'BA8BLK',
      targetCallsign: 'E25XLD/M',
      report: -11,
    });
    assert.strictEqual(message, '<E25XLD/M> BA8BLK -11');
  });

  await t.test('CALL without grid/report (previously a blind spot)', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.CALL,
      senderCallsign: 'BA8BLK',
      targetCallsign: 'E25XLD/M',
    });
    assert.strictEqual(message, '<E25XLD/M> BA8BLK');
  });

  await t.test('CALL with grid', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.CALL,
      senderCallsign: 'BA8BLK',
      targetCallsign: 'E25XLD/M',
      grid: 'PL09',
    });
    assert.strictEqual(message, '<E25XLD/M> BA8BLK PL09');
  });

  await t.test('SEVENTY_THREE', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.SEVENTY_THREE,
      senderCallsign: 'BA8BLK',
      targetCallsign: 'E25XLD/M',
    });
    assert.strictEqual(message, '<E25XLD/M> BA8BLK 73');
  });

  await t.test('wraps the nonstandard side wherever it appears', () => {
    const senderNonstandard = FT8MessageParser.generateMessage({
      type: FT8MessageType.SIGNAL_REPORT,
      senderCallsign: 'E25XLD/M',
      targetCallsign: 'BA8BLK',
      report: -11,
    });
    assert.strictEqual(senderNonstandard, 'BA8BLK <E25XLD/M> -11');
  });
});

test('standard callsigns and /P /R suffixes are not wrapped', async (t) => {
  await t.test('plain standard callsign', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.SIGNAL_REPORT,
      senderCallsign: 'BA8BLK',
      targetCallsign: 'E25XLD',
      report: -11,
    });
    assert.strictEqual(message, 'E25XLD BA8BLK -11');
  });

  await t.test('/P standard suffix (Type 2)', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.SIGNAL_REPORT,
      senderCallsign: 'BA8BLK',
      targetCallsign: 'E25XLD/P',
      report: -11,
    });
    assert.strictEqual(message, 'E25XLD/P BA8BLK -11');
  });

  await t.test('/R standard suffix (Type 1)', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.SIGNAL_REPORT,
      senderCallsign: 'BA8BLK',
      targetCallsign: 'E25XLD/R',
      report: -11,
    });
    assert.strictEqual(message, 'E25XLD/R BA8BLK -11');
  });
});

test('CQ keeps nonstandard callsign bare (wsjtx-lib rejects CQ with <>)', () => {
  // canSendCQGrid 对 /M 返回 false -> 不附 grid；shouldWrapCallsign CQ 不包裹
  const message = FT8MessageParser.generateMessage({
    type: FT8MessageType.CQ,
    senderCallsign: 'E25XLD/M',
    grid: 'PL09',
  });
  assert.strictEqual(message, 'CQ E25XLD/M');
});
