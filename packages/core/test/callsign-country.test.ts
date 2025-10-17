import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCallsignInfo, parseFT8LocationInfo } from '../src/callsign/callsign.js';

test('日本呼号基础国家解析', () => {
  const a = getCallsignInfo('JF1TPR');
  const b = getCallsignInfo('JH6QIL');
  const c = getCallsignInfo('7K4GDC');

  assert.ok(a, 'JF1TPR 应能解析');
  assert.equal(a?.country, 'Japan');
  assert.equal(a?.countryZh, '日本·关东');
  assert.ok(b, 'JH6QIL 应能解析');
  assert.equal(b?.country, 'Japan');
  assert.equal(b?.countryZh, '日本·九州/冲绳');
  assert.ok(c, '7K4GDC 应能解析');
  assert.equal(c?.country, 'Japan');
  assert.equal(c?.countryZh, '日本·东北'); // 7K4中的4是区号,对应东北地区
});

test('韩国呼号基础国家解析(数字开头)', () => {
  const a = getCallsignInfo('6K5SPI');
  const b = getCallsignInfo('6L1KZP');
  const c = getCallsignInfo('HL1VAU');

  assert.ok(a, '6K5SPI 应能解析');
  assert.equal(a?.country, 'South Korea');
  assert.equal(a?.countryZh, '韩国');
  assert.ok(b, '6L1KZP 应能解析');
  assert.equal(b?.country, 'South Korea');
  assert.ok(c, 'HL1VAU 应能解析');
  assert.equal(c?.country, 'South Korea');
});

test('FT8消息解析 - 含数字开头呼号', () => {
  const testCases = [
    { message: '6K5SPI JH3ABK PM74', expected: 'Japan', expectedZh: '日本·关西' },
    { message: '6K5SPI JR2EVU PM85', expected: 'Japan', expectedZh: '日本·东海' },
    { message: 'BG7HFE YB1GRZ OI33', expected: 'Indonesia', expectedZh: '印度尼西亚' }
  ];

  for (const { message, expected, expectedZh } of testCases) {
    const info = parseFT8LocationInfo(message);
    assert.ok(info.country, `消息 "${message}" 应能解析出国家`);
    assert.equal(info.country, expected, `消息 "${message}" 应解析为 ${expected}`);
    assert.equal(info.countryZh, expectedZh, `消息 "${message}" 应解析为 ${expectedZh}`);
  }
});
