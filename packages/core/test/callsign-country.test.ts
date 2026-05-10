import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrefix, getCallsignInfo, parseFT8LocationInfo, resolveDXCCEntity } from '../src/callsign/callsign.js';

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
  assert.equal(a?.country, 'Republic of Korea');
  assert.equal(a?.countryZh, '韩国');
  assert.ok(b, '6L1KZP 应能解析');
  assert.equal(b?.country, 'Republic of Korea');
  assert.ok(c, 'HL1VAU 应能解析');
  assert.equal(c?.country, 'Republic of Korea');
});

test('意大利本土呼号应由通用 I 前缀解析', () => {
  const testCases = ['IZ8EDI', 'IW4DV', 'IU5BJS', 'IK5PWQ'];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'Italy', `呼号 "${callsign}" 应解析为意大利`);
    assert.equal(info?.countryZh, '意大利', `呼号 "${callsign}" 中文应为意大利`);
    assert.equal(info?.entityCode, 248, `呼号 "${callsign}" 实体代码应为 248`);
  }

  const sicily = getCallsignInfo('IT9ABC');
  assert.equal(sicily?.country, 'Sicily');
  assert.equal(sicily?.countryZh, '西西里');
  assert.equal(sicily?.entityCode, 248);
});

test('意大利通用 I 前缀不应覆盖更具体当前 DXCC 实体', () => {
  const sardinia = getCallsignInfo('IS0ABC');
  const sardiniaIw = getCallsignInfo('IW0UAA');
  const currentItaly = getCallsignInfo('IK5ABC', Date.UTC(2026, 3, 19));

  assert.equal(sardinia?.country, 'Sardinia');
  assert.equal(sardinia?.entityCode, 225);
  assert.equal(sardiniaIw?.country, 'Sardinia');
  assert.equal(sardiniaIw?.entityCode, 225);
  assert.equal(currentItaly?.country, 'Italy');
  assert.equal(currentItaly?.entityCode, 248);
  assert.equal(currentItaly?.dxccStatus, 'current');
});

test('BigCTY 同一 DXCC code 的多行前缀应按 CTY 原始行解析', () => {
  const asiaticTurkeyCases = ['TA6B', 'TB6ABC', 'TC6ABC', 'YM6ABC'];

  for (const callsign of asiaticTurkeyCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'Asiatic Turkey', `呼号 "${callsign}" 应解析为亚洲土耳其`);
    assert.equal(info?.countryZh, '土耳其·亚洲');
    assert.equal(info?.entityCode, 390, `呼号 "${callsign}" 实体代码应为 390`);
  }

  const europeanTurkey = getCallsignInfo('TA1ABC');
  assert.equal(europeanTurkey?.country, 'European Turkey');
  assert.equal(europeanTurkey?.countryZh, '土耳其·欧洲');
  assert.equal(europeanTurkey?.entityCode, 390);

  const scotlandGm = getCallsignInfo('GM0ABC');
  const scotlandMm = getCallsignInfo('MM0ABC');
  const svalbard = getCallsignInfo('JW5E');

  assert.equal(scotlandGm?.country, 'Scotland');
  assert.equal(scotlandGm?.entityCode, 279);
  assert.equal(scotlandMm?.country, 'Scotland');
  assert.equal(scotlandMm?.entityCode, 279);
  assert.equal(svalbard?.country, 'Svalbard');
  assert.equal(svalbard?.entityCode, 259);
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

  assert.equal(california?.country, 'United States');
  assert.equal(california?.countryZh, '美国·加州');
  assert.equal(california?.countryEn, 'United States·California');
  assert.equal(california?.state, 'CA');
  assert.equal(california?.stateConfidence, 'low');

  assert.equal(californiaAlt?.country, 'United States');
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

  assert.equal(portableCalifornia?.country, 'United States');
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
    'UI8XYZ',  // 区号 8 但后缀 X 开头（CTY 特例）
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

test('俄罗斯 CTY 特例 - 加里宁格勒', () => {
  const info = getCallsignInfo('UA2FAA');

  assert.equal(info?.country, 'Kaliningrad');
  assert.equal(info?.countryZh, '加里宁格勒');
  assert.equal(info?.entityCode, 126);
  assert.deepEqual(info?.continent, ['EU']);
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

test('FT8 CQ 特殊活动长呼号解析', () => {
  const info = parseFT8LocationInfo('CQ SX100PAOK');

  assert.equal(info.callsign, 'SX100PAOK');
  assert.equal(info.country, 'Greece');
  assert.equal(info.countryZh, '希腊');
  assert.equal(info.countryCode, 'GR');
});

test('FT8消息解析 - 美国 slash 位置指示', () => {
  const message = 'CQ W1AW/KH6 BL11';
  const info = parseFT8LocationInfo(message);

  assert.equal(info.country, 'Hawaii');
  assert.equal(info.state, 'HI');
  assert.equal(info.stateConfidence, 'high');
});

test('FT8 Fox/Hound RR73 消息应优先解析尖括号内的 Fox 呼号', () => {
  const message = 'BG5BNW RR73; RY3PAG <EX7CQ> -20';
  const info = parseFT8LocationInfo(message);

  assert.equal(info.callsign, 'EX7CQ');
  assert.equal(info.country, 'Kyrgyzstan');
  assert.equal(info.countryZh, '吉尔吉斯斯坦');
});

test('FT8 Fox/Hound RR73 消息在仅有短哈希时不应回退到 nextCallsign', () => {
  const message = '23 RR73; JG1MPG <4>';
  const info = parseFT8LocationInfo(message);

  assert.equal(info.callsign, undefined);
  assert.equal(info.country, undefined);
  assert.equal(info.countryZh, undefined);
});

test('前缀冲突优先级 - LU前缀应优先匹配阿根廷', () => {
  // LU 前缀被 5 个实体共享：
  // - Argentina (代码 100, 11个前缀) ← 应优先
  // - South Georgia Island (代码 235, 2个前缀)
  // - South Orkney Islands (代码 238, 2个前缀)
  // - South Sandwich Islands (代码 240, 2个前缀)
  // - South Shetland Islands (代码 241, 5个前缀)

  const testCases = ['LU6YR', 'LU1ABC'];

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

  const testCases = ['CE0ABC', 'CE0YAA'];

  for (const callsign of testCases) {
    const info = getCallsignInfo(callsign);
    assert.ok(info, `呼号 "${callsign}" 应能解析`);
    assert.equal(info?.country, 'Easter Island', `呼号 "${callsign}" 应解析为复活节岛`);
    assert.equal(info?.countryZh, '复活节岛', `呼号 "${callsign}" 中文应为复活节岛`);
    assert.equal(info?.entityCode, 47, `呼号 "${callsign}" 实体代码应为 47`);
  }
});

test('CTY exact-only 例外不应污染通用前缀', () => {
  const itu = getCallsignInfo('4U1ITU');
  const italy = getCallsignInfo('4U1ABC');
  const guantanamo = getCallsignInfo('W1AW/KG4');

  assert.equal(itu?.country, 'ITU HQ');
  assert.equal(itu?.entityCode, 117);
  assert.equal(itu?.dxccMatchKind, 'exact');
  assert.equal(italy?.country, 'Italy');
  assert.equal(italy?.entityCode, 248);
  assert.equal(guantanamo?.country, 'Guantanamo Bay');
  assert.equal(guantanamo?.dxccMatchKind, 'exact');
});

test('CTY slash 与 /MM /AM 语义应接近 WSJT-X', () => {
  assert.equal(getCallsignInfo('W1AW/MM'), undefined);
  assert.equal(getCallsignInfo('W1AW/AM'), undefined);
  assert.equal(getCallsignInfo('W1AW/QRP')?.country, 'United States');
  assert.equal(getCallsignInfo('W1AW/LH')?.country, 'United States');
  assert.equal(getCallsignInfo('KG4ABC')?.country, 'United States');
  assert.equal(getCallsignInfo('KG4AA')?.country, 'Guantanamo Bay');
});

test('WAE-only CTY 行应保留并能解析', () => {
  const vienna = getCallsignInfo('4U1V');

  assert.equal(vienna?.country, 'Vienna Intl Ctr');
  assert.equal(vienna?.entityCode, 206);
  assert.equal(vienna?.dxccStatus, 'current');
});

test('DXCC 解析缓存不应丢失前缀置信度', () => {
  const ts = Date.UTC(2026, 3, 2);
  const first = resolveDXCCEntity('JF1TPR', ts);
  const second = resolveDXCCEntity('JF1TPR', ts);

  assert.equal(first.confidence, 'prefix');
  assert.equal(second.confidence, 'prefix');
  assert.equal(second.entity?.entityCode, 339);
  assert.equal(second.matchKind, 'prefix');
  assert.equal(second.dataSource, 'local');
});
