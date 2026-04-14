import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCallsignInfo, parseFT8LocationInfo, resolveDXCCEntity } from '../src/callsign/callsign.js';

test('日本呼号基础国家解析', () => {
  const a = getCallsignInfo('JF1TPR');
  const b = getCallsignInfo('JH6QIL');
  const c = getCallsignInfo('7K4GDC');
  const d = getCallsignInfo('8J1ABC');
  const e = getCallsignInfo('8N3ABC');
  const f = getCallsignInfo('JA1ABC/6');

  assert.ok(a, 'JF1TPR 应能解析');
  assert.equal(a?.country, 'Japan');
  assert.equal(a?.countryZh, '日本·关东');
  assert.ok(b, 'JH6QIL 应能解析');
  assert.equal(b?.country, 'Japan');
  assert.equal(b?.countryZh, '日本·九州/冲绳');
  assert.ok(c, '7K4GDC 应能解析');
  assert.equal(c?.country, 'Japan');
  assert.equal(c?.countryZh, '日本·关东');
  assert.equal(c?.prefix, '7K');
  assert.ok(d, '8J1ABC 应能解析');
  assert.equal(d?.countryZh, '日本·关东');
  assert.equal(d?.prefix, '8J');
  assert.ok(e, '8N3ABC 应能解析');
  assert.equal(e?.countryZh, '日本·关西');
  assert.equal(e?.prefix, '8N');
  assert.ok(f, 'JA1ABC/6 应能解析');
  assert.equal(f?.countryZh, '日本·九州/冲绳');
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

test('美国特殊实体与州/属地识别', () => {
  const guam = getCallsignInfo('KH2AA');
  const hawaii = getCallsignInfo('KH6VV');
  const hawaiiAlt = getCallsignInfo('AH6ZZ');
  const alaska = getCallsignInfo('KL7AA');
  const puertoRico = getCallsignInfo('KP4AA');
  const usVirginIslands = getCallsignInfo('KP2AA');
  const california = getCallsignInfo('W6ABC');
  const californiaAlt = getCallsignInfo('N6YYZ');

  assert.equal(guam?.country, 'Guam');
  assert.equal(guam?.state, 'GU');
  assert.equal(guam?.stateConfidence, 'high');

  assert.equal(hawaii?.country, 'Hawaii');
  assert.equal(hawaii?.state, 'HI');
  assert.equal(hawaii?.stateConfidence, 'high');

  assert.equal(hawaiiAlt?.country, 'Hawaii');
  assert.equal(hawaiiAlt?.state, 'HI');
  assert.equal(hawaiiAlt?.stateConfidence, 'high');

  assert.equal(alaska?.country, 'Alaska');
  assert.equal(alaska?.state, 'AK');
  assert.equal(alaska?.stateConfidence, 'high');

  assert.equal(puertoRico?.country, 'Puerto Rico');
  assert.equal(puertoRico?.state, 'PR');
  assert.equal(puertoRico?.stateConfidence, 'high');

  assert.equal(usVirginIslands?.country, 'US Virgin Islands');
  assert.equal(usVirginIslands?.state, 'VI');
  assert.equal(usVirginIslands?.stateConfidence, 'high');

  assert.equal(california?.country, 'United States of America');
  assert.equal(california?.countryZh, '美国·加州');
  assert.equal(california?.countryEn, 'United States·California');
  assert.equal(california?.state, 'CA');
  assert.equal(california?.stateConfidence, 'low');

  assert.equal(californiaAlt?.country, 'United States of America');
  assert.equal(californiaAlt?.countryZh, '美国·加州');
  assert.equal(californiaAlt?.countryEn, 'United States·California');
  assert.equal(californiaAlt?.state, 'CA');
  assert.equal(californiaAlt?.stateConfidence, 'low');
});

test('slash 位置指示应优先匹配美国特殊实体', () => {
  const w1awHawaii = getCallsignInfo('W1AW/KH6');
  const kh6Portable = getCallsignInfo('KH6/W1AW');
  const w1awGuam = getCallsignInfo('W1AW/KH2');
  const portableCalifornia = getCallsignInfo('W1AW/6');

  assert.equal(w1awHawaii?.country, 'Hawaii');
  assert.equal(w1awHawaii?.state, 'HI');
  assert.equal(w1awHawaii?.stateConfidence, 'high');
  assert.equal(w1awHawaii?.prefix, 'KH6');

  assert.equal(kh6Portable?.country, 'Hawaii');
  assert.equal(kh6Portable?.state, 'HI');
  assert.equal(kh6Portable?.prefix, 'KH6');

  assert.equal(w1awGuam?.country, 'Guam');
  assert.equal(w1awGuam?.state, 'GU');
  assert.equal(w1awGuam?.prefix, 'KH2');

  assert.equal(portableCalifornia?.country, 'United States of America');
  assert.equal(portableCalifornia?.state, 'CA');
  assert.equal(portableCalifornia?.stateConfidence, 'low');
});

test('俄罗斯呼号区分 - 欧洲部分', () => {
  // UA-UI 系列 数字 1-7 为欧洲俄罗斯
  const testCases = [
    'UA1ABC',  // 区号 1
    'UA3XYZ',  // 区号 3
    'RK7AAA',  // R系列 数字 7
    'R1ABC',   // R系列 数字 1
    'UA2FAA',  // 特殊后缀 F 开头
    'UI8XYZ',  // 区号 8 但后缀 X 开头（特例）
  ];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'European Russia', `呼号 "${callsign}" 应解析为欧洲俄罗斯`);
    assert.equal(info?.countryZh, '俄罗斯·欧洲', `呼号 "${callsign}" 中文应为俄罗斯·欧洲`);
    assert.equal(info?.entityCode, 54, `呼号 "${callsign}" 实体代码应为 54`);
    assert.deepEqual(info?.continent, ['EU'], `呼号 "${callsign}" 应属于欧洲`);
  }
});

test('俄罗斯呼号区分 - 亚洲部分', () => {
  // UA-UI 系列 数字 8, 9, 0 为亚洲俄罗斯（特殊后缀除外）
  const testCases = [
    'UA9ABC',  // 区号 9
    'UA0XYZ',  // 区号 0
    'RK8AAA',  // R系列 数字 8
    'R9ABC',   // R系列 数字 9
    'UI8ABC',  // 区号 8 普通后缀
  ];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'Asiatic Russia', `呼号 "${callsign}" 应解析为亚洲俄罗斯`);
    assert.equal(info?.countryZh, '俄罗斯·亚洲', `呼号 "${callsign}" 中文应为俄罗斯·亚洲`);
    assert.equal(info?.entityCode, 15, `呼号 "${callsign}" 实体代码应为 15`);
    assert.deepEqual(info?.continent, ['AS'], `呼号 "${callsign}" 应属于亚洲`);
  }
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

test('FT8 CQ 带区域标记的消息解析', () => {
  // 典型 FT8 CQ 带 flag 的格式：CQ NA CALL GRID
  const message = 'CQ NA BI1RRE ON80';
  const info = parseFT8LocationInfo(message);
  // 应从消息中正确识别发送者呼号所在国家（BI1RRE 为中国）
  assert.ok(info.country, '应能解析出国家');
  assert.equal(info.country, 'China');
  assert.equal(info.countryZh, '中国·北京');
});

test('FT8消息解析 - 美国 slash 位置指示', () => {
  const message = 'CQ W1AW/KH6 BL11';
  const info = parseFT8LocationInfo(message);

  assert.equal(info.country, 'Hawaii');
  assert.equal(info.state, 'HI');
  assert.equal(info.stateConfidence, 'high');
});

test('前缀冲突优先级 - LU前缀应优先匹配阿根廷', () => {
  // LU 前缀被 5 个实体共享：
  // - Argentina (代码 100, 11个前缀) ← 应优先
  // - South Georgia Island (代码 235, 2个前缀)
  // - South Orkney Islands (代码 238, 2个前缀)
  // - South Sandwich Islands (代码 240, 2个前缀)
  // - South Shetland Islands (代码 241, 5个前缀)

  const testCases = ['LU6YR', 'LU1ABC', 'LU9ZZZ'];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'Argentina', `呼号 "${callsign}" 应解析为阿根廷`);
    assert.equal(info?.countryZh, '阿根廷', `呼号 "${callsign}" 中文应为阿根廷`);
    assert.equal(info?.flag, '🇦🇷', `呼号 "${callsign}" 国旗应为阿根廷`);
    assert.equal(info?.entityCode, 100, `呼号 "${callsign}" 实体代码应为 100`);
  }
});

test('前缀冲突优先级 - VP8前缀应优先匹配福克兰群岛', () => {
  // VP8 前缀被 5 个实体共享：
  // - Falkland Islands (代码 141, 1个前缀) ← 应优先（代码最小）
  // - South Georgia Island (代码 235, 2个前缀)
  // - South Orkney Islands (代码 238, 2个前缀)
  // - South Sandwich Islands (代码 240, 2个前缀)
  // - South Shetland Islands (代码 241, 5个前缀)

  const testCases = ['VP8ABC', 'VP8XYZ'];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'Falkland Islands', `呼号 "${callsign}" 应解析为福克兰群岛`);
    assert.equal(info?.countryZh, '福克兰群岛', `呼号 "${callsign}" 中文应为福克兰群岛`);
    assert.equal(info?.flag, '🇫🇰', `呼号 "${callsign}" 国旗应为福克兰群岛`);
    assert.equal(info?.entityCode, 141, `呼号 "${callsign}" 实体代码应为 141`);
  }
});

test('前缀冲突优先级 - TX前缀应优先匹配法国', () => {
  // TX 前缀被 6 个实体共享：
  // - France (代码 227, 11个前缀) ← 应优先（前缀数量最多）
  // - Clipperton Island (代码 36, 2个前缀)
  // - New Caledonia (代码 162, 2个前缀)
  // - French Polynesia (代码 175, 2个前缀)
  // - Marquesas Islands (代码 509, 2个前缀)
  // - Chesterfield Islands (代码 512, 2个前缀)

  const testCases = ['TX5ABC', 'TX7XYZ'];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'France', `呼号 "${callsign}" 应解析为法国`);
    assert.equal(info?.countryZh, '法国', `呼号 "${callsign}" 中文应为法国`);
    assert.equal(info?.flag, '🇫🇷', `呼号 "${callsign}" 国旗应为法国`);
    assert.equal(info?.entityCode, 227, `呼号 "${callsign}" 实体代码应为 227`);
  }
});

test('前缀冲突优先级 - CE0前缀应优先匹配复活节岛', () => {
  // CE0 前缀被 3 个实体共享：
  // - Easter Island (代码 47) ← 应优先（代码最小）
  // - Juan Fernández Islands (代码 125)
  // - Desventuradas Islands (代码 217)

  const testCases = ['CE0ABC', 'CE0XYZ'];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'Easter Island', `呼号 "${callsign}" 应解析为复活节岛`);
    assert.equal(info?.countryZh, '复活节岛', `呼号 "${callsign}" 中文应为复活节岛`);
    assert.equal(info?.entityCode, 47, `呼号 "${callsign}" 实体代码应为 47`);
  }
});

test('DXCC 解析应根据通联日期选择历史实体', () => {
  const westGermany = getCallsignInfo('DA1ABC', Date.UTC(1970, 0, 1));
  const germany = getCallsignInfo('DA1ABC', Date.UTC(1980, 0, 1));
  const czechoslovakia = getCallsignInfo('OK1ABC', Date.UTC(1992, 5, 1));
  const czechRepublic = getCallsignInfo('OK1ABC', Date.UTC(1994, 5, 1));
  const ryukyu = getCallsignInfo('JR6AAA', Date.UTC(1970, 0, 1));
  const okinotorishima = getCallsignInfo('7J1AAA', Date.UTC(1978, 0, 1));

  assert.equal(westGermany?.country, 'West Germany');
  assert.equal(westGermany?.entityCode, 81);
  assert.equal(westGermany?.dxccStatus, 'deleted');

  assert.equal(germany?.country, 'Germany');
  assert.equal(germany?.entityCode, 230);
  assert.equal(germany?.dxccStatus, 'current');

  assert.equal(czechoslovakia?.country, 'Czechoslovakia');
  assert.equal(czechoslovakia?.entityCode, 218);
  assert.equal(czechoslovakia?.dxccStatus, 'deleted');

  assert.equal(czechRepublic?.country, 'Czech Republic');
  assert.equal(czechRepublic?.entityCode, 503);
  assert.equal(czechRepublic?.dxccStatus, 'current');

  assert.equal(ryukyu?.country, 'Ryukyu Islands');
  assert.equal(ryukyu?.entityCode, 193);
  assert.equal(ryukyu?.dxccStatus, 'deleted');

  assert.equal(okinotorishima?.country, 'Okinotorishima');
  assert.equal(okinotorishima?.entityCode, 194);
  assert.equal(okinotorishima?.dxccStatus, 'deleted');
});

test('DXCC 解析缓存不应丢失前缀置信度', () => {
  const ts = Date.UTC(2026, 3, 2);
  const first = resolveDXCCEntity('JF1TPR', ts);
  const second = resolveDXCCEntity('JF1TPR', ts);

  assert.equal(first.confidence, 'prefix');
  assert.equal(second.confidence, 'prefix');
  assert.equal(second.entity?.entityCode, 339);
});
