import { getCallsignInfo } from '@tx5dr/core';
import {
  cabrilloSubmission,
  composeFT8ContestPlugin,
  defineCompletionModule,
  defineFT8Contest,
  defineFT8ExchangeModule,
  distancePoints,
  fixedPoints,
  fixedWeekendEdition,
  gridAndSnrExchange,
  gridExchange,
  gridFieldMultiplier,
  maidenheadDistanceKm,
  multiplierKeysFrom,
  oncePerBand,
  requireExchangeAndFinalAck,
  scoreBy,
  type ContestExchangeFields,
  type ContestValidationIssue,
  type FT8ContestDefinition,
  type FT8ContestMode,
  type FT8ContestQso,
  type GridAndSnrExchange,
  type GridExchange,
} from '@tx5dr/plugin-api/contest';
import type { AnyPluginDefinition } from '@tx5dr/plugin-api';
import type { StrategyPluginContext } from '@tx5dr/plugin-api';
import {
  contestLocaleLabel,
  createContestStrategyRuntime,
  standardQSOQuickSettings,
  standardQSOSettings,
} from '../_shared/contest-runtime.js';

export const FT_CONTEST_PLUGIN_NAMES = {
  arrlDigital: 'arrl-digital',
  ftRoundup: 'ft-roundup',
  ftChallenge: 'ft-challenge',
  europeanFt8Dx: 'european-ft8-dx',
  europeanFt4Dx: 'european-ft4-dx',
  rsgbFt4InternationalActivityDay: 'rsgb-ft4-international-activity-day',
  rsgbFt4ContestSeries: 'rsgb-ft4-contest-series',
  ft8ActivityEurope: 'ft8-activity-europe',
  ft8ActivityNa: 'ft8-activity-na',
  ncccFt4Sprint: 'nccc-ft4-sprint',
  bataviaFt8: 'batavia-ft8',
  ybdxpiFt8: 'ybdxpi-ft8',
  africaFt4Dx: 'africa-ft4-dx',
} as const;

export type FTContestPluginName =
  typeof FT_CONTEST_PLUGIN_NAMES[keyof typeof FT_CONTEST_PLUGIN_NAMES];

export interface ContestStationQso<TExchange = unknown> {
  callsign: string;
  band: string;
  mode: FT8ContestMode;
  startTime: number;
  status?: FT8ContestQso<TExchange>['status'];
  sentExchange?: TExchange;
  receivedExchange?: TExchange;
  distanceKm?: number;
  operatorCallsign: string;
  operatorGrid?: string;
  frequencyKhz?: number;
}

export interface MemberAwareContestQso<TExchange = unknown> extends ContestStationQso<TExchange> {
  member?: boolean;
}

export type GridContestQso = ContestStationQso<GridExchange>;
export type GridSnrContestQso = ContestStationQso<GridAndSnrExchange>;

export type RoundupExchange =
  | { kind: 'state'; report: string; value: string }
  | { kind: 'province'; report: string; value: string }
  | { kind: 'serial'; report: string; value: string };

export type RoundupQso = ContestStationQso<RoundupExchange>;

type AnyContest = FT8ContestDefinition<unknown, FT8ContestQso<unknown>, void>;

export interface FTContestCatalogEntry {
  name: FTContestPluginName;
  title: string;
  contest: AnyContest;
  definition: AnyPluginDefinition;
  locales: Record<string, Record<string, string>>;
}

function edition(id: string, startAt: string, endAt: string, url: string) {
  return fixedWeekendEdition({
    id,
    startAt,
    endAt,
    source: { url, confirmedAt: '2026-09-01T00:00:00.000Z' },
  });
}

function isoCabrilloDateTime(startTime: number): string {
  const date = new Date(startTime);
  if (!Number.isFinite(date.getTime())) return '1970-01-01 0000';
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16).replace(':', '')}`;
}

function frequencyKhz(qso: ContestStationQso): number {
  return Number.isFinite(qso.frequencyKhz) ? Math.round(qso.frequencyKhz ?? 0) : 0;
}

function gridText(exchange?: GridExchange): string {
  return exchange?.grid ?? '';
}

function gridSnrText(exchange?: GridAndSnrExchange): string {
  if (!exchange) return '';
  return `${exchange.snr} ${exchange.grid}`.trim();
}

function roundupText(exchange?: RoundupExchange): string {
  if (!exchange) return '';
  return `${exchange.report} ${exchange.value}`.trim();
}

function cabrillo<TQso extends ContestStationQso<TExchange>, TExchange>(
  contestId: string,
  exchangeText: (exchange: TExchange | undefined) => string,
) {
  return cabrilloSubmission<TQso>({
    headers: () => [['CONTEST', contestId]],
    qsoLine: (qso) =>
      `QSO: ${frequencyKhz(qso)} DG ${isoCabrilloDateTime(qso.startTime)} ${qso.operatorCallsign} ${exchangeText(qso.sentExchange)} ${qso.callsign} ${exchangeText(qso.receivedExchange)}`,
  });
}

function callInfo(callsign: string, startTime: number) {
  return getCallsignInfo(callsign, startTime);
}

function countryCode(callsign: string, startTime: number): string | undefined {
  return callInfo(callsign, startTime)?.countryCode?.toUpperCase();
}

function dxccKey(callsign: string, startTime: number): string | undefined {
  const info = callInfo(callsign, startTime);
  return info?.entityCode !== undefined ? String(info.entityCode) : info?.countryCode?.toUpperCase();
}

function prefixKey(callsign: string, startTime: number): string | undefined {
  return callInfo(callsign, startTime)?.prefix?.trim().toUpperCase();
}

function continent(callsign: string, startTime: number): string | undefined {
  return callInfo(callsign, startTime)?.continent?.[0]?.toUpperCase();
}

function sameCountry(qso: ContestStationQso): boolean {
  const operator = countryCode(qso.operatorCallsign, qso.startTime);
  const contact = countryCode(qso.callsign, qso.startTime);
  return Boolean(operator && contact && operator === contact);
}

function sameContinent(qso: ContestStationQso): boolean {
  const operator = continent(qso.operatorCallsign, qso.startTime);
  const contact = continent(qso.callsign, qso.startTime);
  return Boolean(operator && contact && operator === contact);
}

function gridDistance(qso: ContestStationQso<GridExchange | GridAndSnrExchange>): number | undefined {
  if (qso.distanceKm !== undefined) return qso.distanceKm;
  const receivedGrid = qso.receivedExchange?.grid;
  if (!qso.operatorGrid || !receivedGrid) return undefined;
  return maidenheadDistanceKm(qso.operatorGrid, receivedGrid);
}

function gridDistanceScoring<TQso extends ContestStationQso<GridExchange | GridAndSnrExchange>>(
  options: {
    stepKm: number;
    rounding?: 'floor' | 'ceil';
    minimumDistanceSteps?: number;
    missingDistancePoints?: number;
    multiplierBandScoped?: boolean;
  },
) {
  return distancePoints<TQso>({
    stepKm: options.stepKm,
    rounding: options.rounding,
    minimumDistanceSteps: options.minimumDistanceSteps,
    missingDistancePoints: options.missingDistancePoints,
    distanceKm: gridDistance,
    multiplierKeys: gridFieldMultiplier({
      grid: (qso) => qso.receivedExchange?.grid,
      band: options.multiplierBandScoped === false ? undefined : (qso) => qso.band,
    }),
  });
}

const reportAndLocationExchange = defineFT8ExchangeModule<RoundupExchange>({
  id: 'report-state-province-or-serial',
  decode(fields: ContestExchangeFields) {
    const report = fields.report?.trim();
    const issues: ContestValidationIssue[] = [];
    if (!report || !/^[+-]?\d{1,2}$/.test(report)) {
      issues.push({ code: 'invalid_report', field: 'report' });
    }
    const state = fields.state?.trim().toUpperCase();
    if (state && /^[A-Z]{2}$/.test(state)) {
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { kind: 'state', report: report!, value: state } };
    }
    const province = fields.province?.trim().toUpperCase();
    if (province && /^[A-Z]{2,3}$/.test(province)) {
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { kind: 'province', report: report!, value: province } };
    }
    const serial = fields.serial?.trim();
    if (serial && /^\d{3,4}$/.test(serial)) {
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { kind: 'serial', report: report!, value: serial } };
    }
    issues.push({ code: 'state_province_or_serial_required' });
    return { ok: false, issues };
  },
  encode(exchange): ContestExchangeFields {
    if (exchange.kind === 'state') return { report: exchange.report, state: exchange.value };
    if (exchange.kind === 'province') return { report: exchange.report, province: exchange.value };
    return { report: exchange.report, serial: exchange.value };
  },
  validate(exchange) {
    return validateRoundupExchange(exchange);
  },
});

function validateRoundupExchange(exchange: RoundupExchange): readonly ContestValidationIssue[] {
  const encoded: ContestExchangeFields = reportAndLocationExchange.encode(exchange);
  const decoded = reportAndLocationExchange.decode(encoded);
  return decoded.ok ? [] : decoded.issues;
}

const receivedExchangeOnly = defineCompletionModule({
  id: 'received-exchange',
  evaluate(evidence) {
    return evidence.receivedExchange
      ? { complete: true, missing: [] }
      : { complete: false, missing: ['received_exchange'] };
  },
});

function roundupMultiplierKeys(qso: RoundupQso): readonly string[] {
  if (qso.receivedExchange?.kind === 'state') return [`STATE:${qso.receivedExchange.value}`];
  if (qso.receivedExchange?.kind === 'province') return [`PROVINCE:${qso.receivedExchange.value}`];
  const dxcc = dxccKey(qso.callsign, qso.startTime);
  return dxcc ? [`DXCC:${dxcc}`] : [];
}

function prefixAndDxccMultiplierKeys(qso: ContestStationQso): readonly string[] {
  const prefixKeys = multiplierKeysFrom<ContestStationQso>({
    key: (record) => prefixKey(record.callsign, record.startTime),
    band: (record) => record.band,
  })(qso).map((key) => `PREFIX:${key}`);
  const dxccKeys = multiplierKeysFrom<ContestStationQso>({
    key: (record) => dxccKey(record.callsign, record.startTime),
    band: (record) => record.band,
  })(qso).map((key) => `DXCC:${key}`);
  return [...prefixKeys, ...dxccKeys];
}

function ybContestPoints(qso: MemberAwareContestQso): number {
  if (qso.member) return 5;
  const operatorIsYb = countryCode(qso.operatorCallsign, qso.startTime) === 'ID';
  const contactIsYb = countryCode(qso.callsign, qso.startTime) === 'ID';
  if (operatorIsYb) return contactIsYb ? 1 : 2;
  if (sameCountry(qso)) return 0;
  return contactIsYb ? 2 : 1;
}

function rsgbFt4Points(qso: ContestStationQso): number {
  return sameContinent(qso) ? 1 : 3;
}

function africaFt4Points(qso: ContestStationQso): number {
  const operatorInAfrica = continent(qso.operatorCallsign, qso.startTime) === 'AF';
  const contactInAfrica = continent(qso.callsign, qso.startTime) === 'AF';
  if (sameCountry(qso)) return 4;
  if (operatorInAfrica === contactInAfrica) return 6;
  return 1;
}

function contestPlugin<TExchange, TQso extends FT8ContestQso<TExchange>>(
  name: FTContestPluginName,
  contest: FT8ContestDefinition<TExchange, TQso, void>,
): AnyPluginDefinition {
  return composeFT8ContestPlugin({
    name,
    version: '1.0.0',
    description: 'pluginDescription',
    settings: standardQSOSettings,
    quickSettings: standardQSOQuickSettings,
    contest,
    runtime: (_contest: AnyContest, ctx: StrategyPluginContext) => createContestStrategyRuntime(ctx),
  });
}

function createEntry<TExchange, TQso extends FT8ContestQso<TExchange>>(
  input: {
    name: FTContestPluginName;
    title: string;
    contest: FT8ContestDefinition<TExchange, TQso, void>;
    en: string;
    zh: string;
    ja: string;
  },
): FTContestCatalogEntry {
  return {
    name: input.name,
    title: input.title,
    contest: input.contest as AnyContest,
    definition: contestPlugin(input.name, input.contest),
    locales: contestLocaleLabel(input.en, input.zh, input.ja),
  };
}

function gridContest(
  input: {
    id: string;
    rulesetVersion: string;
    mode?: FT8ContestMode;
    bands: readonly string[];
    editionId: string;
    startAt: string;
    endAt: string;
    url: string;
    contestHeader: string;
    scoring: ReturnType<typeof distancePoints>;
  },
) {
  return defineFT8Contest<GridExchange, GridContestQso>({
    id: input.id,
    rulesetVersion: input.rulesetVersion,
    edition: edition(input.editionId, input.startAt, input.endAt, input.url),
    modes: input.mode ? [input.mode] : ['FT8', 'FT4'],
    bands: input.bands,
    exchange: gridExchange(),
    completion: requireExchangeAndFinalAck(),
    scoring: input.scoring,
    submission: cabrillo<GridContestQso, GridExchange>(input.contestHeader, gridText),
  });
}

export const arrlDigitalContest = gridContest({
  id: 'arrl-digital',
  rulesetVersion: '2026.1',
  editionId: '2026',
  startAt: '2026-06-06T18:00:00.000Z',
  endAt: '2026-06-07T23:59:59.000Z',
  url: 'https://contests.arrl.org/ContestRules/Digital-Rules.pdf',
  bands: ['160M', '80M', '40M', '20M', '15M', '10M', '6M'],
  contestHeader: 'ARRL-DIGITAL',
  scoring: distancePoints<GridContestQso>({
    stepKm: 500,
    rounding: 'ceil',
    minimumDistanceSteps: 1,
    distanceKm: gridDistance,
  }),
});

export const ftChallengeContest = defineFT8Contest<GridAndSnrExchange, GridSnrContestQso>({
  id: 'ft-challenge',
  rulesetVersion: '2026.1',
  edition: edition('2026', '2026-12-05T00:00:00.000Z', '2026-12-06T23:59:59.000Z', 'https://www.rttycontesting.com/ft-challenge/rules/'),
  modes: ['FT8', 'FT4'],
  bands: ['80M', '40M', '20M', '15M', '10M'],
  exchange: gridAndSnrExchange({ missingGrid: 'ZZ00' }),
  completion: requireExchangeAndFinalAck(),
  scoring: gridDistanceScoring<GridSnrContestQso>({
    stepKm: 3000,
    missingDistancePoints: 1,
  }),
  submission: cabrillo<GridSnrContestQso, GridAndSnrExchange>('FT-CHALLENGE', gridSnrText),
});

export const ftRoundupContest = defineFT8Contest<RoundupExchange, RoundupQso>({
  id: 'ft-roundup',
  rulesetVersion: '2026.1',
  edition: edition('2026', '2026-12-05T18:00:00.000Z', '2026-12-06T23:59:59.000Z', 'https://www.rttycontesting.com/ft-roundup/rules/'),
  modes: ['FT8', 'FT4'],
  bands: ['80M', '40M', '20M', '15M', '10M'],
  exchange: reportAndLocationExchange,
  completion: receivedExchangeOnly,
  dupe: oncePerBand(),
  scoring: fixedPoints<RoundupQso>(1, { multiplierKeys: roundupMultiplierKeys }),
  submission: cabrillo<RoundupQso, RoundupExchange>('FT-RU', roundupText),
});

export const europeanFt8DxContest = gridContest({
  id: 'european-ft8-dx',
  rulesetVersion: '2026.1',
  mode: 'FT8',
  editionId: '2026',
  startAt: '2026-04-11T12:00:00.000Z',
  endAt: '2026-04-12T11:59:59.000Z',
  url: 'https://europeanft8club.wordpress.com/',
  bands: ['80M', '40M', '20M', '15M', '10M'],
  contestHeader: 'EUROPEAN-FT8-DX',
  scoring: gridDistanceScoring<GridContestQso>({ stepKm: 3000 }),
});

export const europeanFt4DxContest = gridContest({
  id: 'european-ft4-dx',
  rulesetVersion: '2026.1',
  mode: 'FT4',
  editionId: '2026',
  startAt: '2026-02-21T12:00:00.000Z',
  endAt: '2026-02-22T11:59:59.000Z',
  url: 'https://europeanft8club.wordpress.com/',
  bands: ['80M', '40M', '20M', '15M', '10M'],
  contestHeader: 'EUROPEAN-FT4-DX',
  scoring: gridDistanceScoring<GridContestQso>({ stepKm: 3000 }),
});

export const rsgbFt4InternationalActivityDayContest = defineFT8Contest<GridExchange, GridContestQso>({
  id: 'rsgb-ft4-international-activity-day',
  rulesetVersion: '2026.1',
  edition: edition('2026', '2026-04-11T12:00:00.000Z', '2026-04-12T11:59:59.000Z', 'https://www.rsgbcc.org/hf/rules/2026/rallband_ft4.shtml'),
  modes: ['FT4'],
  bands: ['80M', '40M', '20M', '15M', '10M'],
  exchange: gridExchange(),
  completion: receivedExchangeOnly,
  scoring: scoreBy<GridContestQso>({
    id: 'rsgb-ft4-continent-dxcc',
    points: rsgbFt4Points,
    eligible: (qso) => Boolean(continent(qso.operatorCallsign, qso.startTime) && continent(qso.callsign, qso.startTime)),
    multiplierKeys: multiplierKeysFrom({
      key: (qso: GridContestQso) => dxccKey(qso.callsign, qso.startTime),
      band: (qso) => qso.band,
    }),
  }),
  submission: cabrillo<GridContestQso, GridExchange>('RSGB-FT4-IAD', gridText),
});

export const rsgbFt4ContestSeriesContest = defineFT8Contest<GridExchange, GridContestQso>({
  id: 'rsgb-ft4-contest-series',
  rulesetVersion: '2026.1',
  edition: edition('2026', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.000Z', 'https://www.rsgbcc.org/hf/rules/2026/r80m_ft4.shtml'),
  modes: ['FT4'],
  bands: ['80M'],
  exchange: gridExchange(),
  completion: receivedExchangeOnly,
  scoring: scoreBy<GridContestQso>({
    id: 'rsgb-ft4-series-continent-dxcc',
    points: rsgbFt4Points,
    eligible: (qso) => Boolean(continent(qso.operatorCallsign, qso.startTime) && continent(qso.callsign, qso.startTime)),
    multiplierKeys: multiplierKeysFrom({
      key: (qso: GridContestQso) => dxccKey(qso.callsign, qso.startTime),
    }),
  }),
  submission: cabrillo<GridContestQso, GridExchange>('RSGB-FT4-SERIES', gridText),
});

function vhfActivityContest(input: {
  id: string;
  mode?: FT8ContestMode;
  editionId: string;
  startAt: string;
  endAt: string;
  url: string;
  contestHeader: string;
}) {
  return defineFT8Contest<GridExchange, GridContestQso>({
    id: input.id,
    rulesetVersion: '2026.1',
    edition: edition(input.editionId, input.startAt, input.endAt, input.url),
    modes: input.mode ? [input.mode] : ['FT8', 'FT4'],
    bands: ['2M', '70CM', '23CM'],
    exchange: gridExchange(),
    completion: receivedExchangeOnly,
    scoring: fixedPoints<GridContestQso>(1, {
      multiplierKeys: gridFieldMultiplier({ grid: (qso) => qso.receivedExchange?.grid, band: undefined }),
    }),
    submission: cabrillo<GridContestQso, GridExchange>(input.contestHeader, gridText),
  });
}

export const ft8ActivityEuropeContest = vhfActivityContest({
  id: 'ft8-activity-europe',
  editionId: '2026-09',
  startAt: '2026-09-02T17:00:00.000Z',
  endAt: '2026-09-02T21:00:00.000Z',
  url: 'https://ft8activity.eu/rules/',
  contestHeader: 'FT8-ACTIVITY-EU',
});

export const ft8ActivityNaContest = vhfActivityContest({
  id: 'ft8-activity-na',
  editionId: '2026-09',
  startAt: '2026-09-02T17:00:00.000Z',
  endAt: '2026-09-02T21:00:00.000Z',
  url: 'https://ft8activity-na.net/rules/',
  contestHeader: 'FT8-ACTIVITY-NA',
});

export const ncccFt4SprintContest = vhfActivityContest({
  id: 'nccc-ft4-sprint',
  mode: 'FT4',
  editionId: '2026-09-04',
  startAt: '2026-09-04T01:00:00.000Z',
  endAt: '2026-09-04T03:00:00.000Z',
  url: 'https://www.contestcalendar.com/contestdetails.php?ref=741',
  contestHeader: 'NCCC-FT4-SPRINT',
});

function ybStyleContest(input: {
  id: string;
  title: string;
  editionId: string;
  startAt: string;
  endAt: string;
  url: string;
  contestHeader: string;
}) {
  return defineFT8Contest<GridExchange, MemberAwareContestQso<GridExchange>>({
    id: input.id,
    rulesetVersion: '2026.1',
    edition: edition(input.editionId, input.startAt, input.endAt, input.url),
    modes: ['FT8'],
    bands: ['80M', '40M', '20M', '15M', '10M'],
    exchange: gridExchange(),
    completion: receivedExchangeOnly,
    scoring: scoreBy<MemberAwareContestQso<GridExchange>>({
      id: `${input.id}-yb-dx-prefix-dxcc`,
      points: ybContestPoints,
      eligible: (qso) => Boolean(countryCode(qso.operatorCallsign, qso.startTime) && countryCode(qso.callsign, qso.startTime)),
      multiplierKeys: prefixAndDxccMultiplierKeys,
    }),
    submission: cabrillo<MemberAwareContestQso<GridExchange>, GridExchange>(input.contestHeader, gridText),
  });
}

export const bataviaFt8Contest = ybStyleContest({
  id: 'batavia-ft8',
  title: 'Batavia FT8 Contest',
  editionId: '2026',
  startAt: '2026-08-01T00:00:00.000Z',
  endAt: '2026-08-02T23:59:59.000Z',
  url: 'https://www.contestcalendar.com/contestdetails.php?ref=677',
  contestHeader: 'BATAVIA-FT8',
});

export const ybdxpiFt8Contest = ybStyleContest({
  id: 'ybdxpi-ft8',
  title: 'YBDXPI FT8 Contest',
  editionId: '2026',
  startAt: '2026-10-24T00:00:00.000Z',
  endAt: '2026-10-25T23:59:59.000Z',
  url: 'https://orari.or.id/event/ybdxpi-ft8-contest/',
  contestHeader: 'YBDXPI-FT8',
});

export const africaFt4DxContest = defineFT8Contest<GridExchange, GridContestQso>({
  id: 'africa-ft4-dx',
  rulesetVersion: '2026.1',
  edition: edition('2026', '2026-03-07T12:00:00.000Z', '2026-03-08T12:00:00.000Z', 'https://mysarl.org.za/contest-resources/'),
  modes: ['FT4'],
  bands: ['80M', '40M', '20M', '15M', '10M'],
  exchange: gridExchange(),
  completion: receivedExchangeOnly,
  scoring: scoreBy<GridContestQso>({
    id: 'africa-ft4-continent',
    points: africaFt4Points,
    eligible: (qso) => Boolean(continent(qso.operatorCallsign, qso.startTime) && continent(qso.callsign, qso.startTime)),
  }),
  submission: cabrillo<GridContestQso, GridExchange>('AFRICA-FT4-DX', gridText),
});

export const ftContestCatalog: readonly FTContestCatalogEntry[] = Object.freeze([
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.arrlDigital,
    title: 'ARRL International Digital Contest',
    contest: arrlDigitalContest,
    en: 'Built-in ARRL International Digital Contest strategy',
    zh: '内置 ARRL International Digital Contest 比赛策略',
    ja: '内蔵 ARRL International Digital Contest コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.ftRoundup,
    title: 'FT Roundup',
    contest: ftRoundupContest,
    en: 'Built-in FT Roundup strategy',
    zh: '内置 FT Roundup 比赛策略',
    ja: '内蔵 FT Roundup コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.ftChallenge,
    title: 'FT Challenge',
    contest: ftChallengeContest,
    en: 'Built-in FT Challenge strategy',
    zh: '内置 FT Challenge 比赛策略',
    ja: '内蔵 FT Challenge コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.europeanFt8Dx,
    title: 'European FT8 DX Contest',
    contest: europeanFt8DxContest,
    en: 'Built-in European FT8 DX Contest strategy',
    zh: '内置 European FT8 DX Contest 比赛策略',
    ja: '内蔵 European FT8 DX Contest コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.europeanFt4Dx,
    title: 'European FT4 DX Contest',
    contest: europeanFt4DxContest,
    en: 'Built-in European FT4 DX Contest strategy',
    zh: '内置 European FT4 DX Contest 比赛策略',
    ja: '内蔵 European FT4 DX Contest コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.rsgbFt4InternationalActivityDay,
    title: 'RSGB FT4 International Activity Day',
    contest: rsgbFt4InternationalActivityDayContest,
    en: 'Built-in RSGB FT4 International Activity Day strategy',
    zh: '内置 RSGB FT4 International Activity Day 比赛策略',
    ja: '内蔵 RSGB FT4 International Activity Day コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.rsgbFt4ContestSeries,
    title: 'RSGB FT4 Contest Series',
    contest: rsgbFt4ContestSeriesContest,
    en: 'Built-in RSGB FT4 Contest Series strategy',
    zh: '内置 RSGB FT4 Contest Series 比赛策略',
    ja: '内蔵 RSGB FT4 Contest Series コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.ft8ActivityEurope,
    title: 'VHF-UHF FT8 Activity Europe',
    contest: ft8ActivityEuropeContest,
    en: 'Built-in VHF-UHF FT8 Activity Europe strategy',
    zh: '内置 VHF-UHF FT8 Activity Europe 比赛策略',
    ja: '内蔵 VHF-UHF FT8 Activity Europe コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.ft8ActivityNa,
    title: 'VHF-UHF FT8 Activity-NA',
    contest: ft8ActivityNaContest,
    en: 'Built-in VHF-UHF FT8 Activity-NA strategy',
    zh: '内置 VHF-UHF FT8 Activity-NA 比赛策略',
    ja: '内蔵 VHF-UHF FT8 Activity-NA コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.ncccFt4Sprint,
    title: 'NCCC FT4 Sprint',
    contest: ncccFt4SprintContest,
    en: 'Built-in NCCC FT4 Sprint strategy',
    zh: '内置 NCCC FT4 Sprint 比赛策略',
    ja: '内蔵 NCCC FT4 Sprint コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.bataviaFt8,
    title: 'Batavia FT8 Contest',
    contest: bataviaFt8Contest,
    en: 'Built-in Batavia FT8 Contest strategy',
    zh: '内置 Batavia FT8 Contest 比赛策略',
    ja: '内蔵 Batavia FT8 Contest コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.ybdxpiFt8,
    title: 'YBDXPI FT8 Contest',
    contest: ybdxpiFt8Contest,
    en: 'Built-in YBDXPI FT8 Contest strategy',
    zh: '内置 YBDXPI FT8 Contest 比赛策略',
    ja: '内蔵 YBDXPI FT8 Contest コンテスト戦略',
  }),
  createEntry({
    name: FT_CONTEST_PLUGIN_NAMES.africaFt4Dx,
    title: 'Africa FT4 DX Contest',
    contest: africaFt4DxContest,
    en: 'Built-in Africa FT4 DX Contest strategy',
    zh: '内置 Africa FT4 DX Contest 比赛策略',
    ja: '内蔵 Africa FT4 DX Contest コンテスト戦略',
  }),
]);

export const ftContestBuiltinPluginEntries = ftContestCatalog.map((entry) => ({
  definition: entry.definition,
  locales: entry.locales,
  enabledByDefault: false,
}));
