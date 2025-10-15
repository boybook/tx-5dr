import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCallsignInfo } from '../src/callsign/callsign.js';

test('日本呼号基础国家解析', () => {
  const a = getCallsignInfo('JF1TPR');
  const b = getCallsignInfo('JH6QIL');
  const c = getCallsignInfo('7K4GDC');

  assert.ok(a, 'JF1TPR 应能解析');
  assert.equal(a?.country, 'Japan');
  assert.ok(b, 'JH6QIL 应能解析');
  assert.equal(b?.country, 'Japan');
  assert.ok(c, '7K4GDC 应能解析');
  assert.equal(c?.country, 'Japan');
});
