import type { PluginPanelDescriptor, PluginPermission, PluginQuickSetting, PluginSettingDescriptor, PluginUIPageDescriptor, QSORecord } from '@tx5dr/contracts';
import { getBandFromFrequency } from '@tx5dr/core';
import type { PluginHooks } from '../../hooks.js';
import type { PluginContextFor } from '../../context.js';
import type { PluginUIRequestContext } from '../../helpers.js';
import type { VersionedContestSession } from './ContestSessionRepository.js';
import { defaultContestSession, type ContestSessionContext, type ContestSessionIdentity } from './DefaultContestSession.js';
import { defaultContestWorkbench, type ContestWorkbenchQsoRow, type ContestWorkbenchViewModel, type DefaultContestWorkbenchOptions, type ContestWorkbenchRequest } from './DefaultContestWorkbench.js';
import type { ContestSessionModule, ContestWorkbenchModule } from './FT8ContestPlugin.js';
import type { ContestSessionHealth } from './DefaultContestSession.js';
import type { FT8ContestDefinition } from './FT8ContestDefinition.js';
import { formatFT8ContestSubmission, projectFT8ContestQsos, scoreFT8ContestQsos } from './FT8ContestDefinition.js';
import type { FT8ContestQso } from './FT8ContestModules.js';
import type { ContestQsoEnvelopeAdapter } from './ContestQsoEnvelopeAdapter.js';
import { maidenheadDistanceKm } from './FT8ContestModules.js';

export const CONTEST_LOGBOOK_PERMISSIONS = [
  'logbook:session',
  'plugin:event-bus',
] as const satisfies readonly PluginPermission[];

export type ContestLogbookPermissions = typeof CONTEST_LOGBOOK_PERMISSIONS;

export interface ContestLogbookReviewIssue {
  code: string;
  message: string;
  qsoId?: string;
  field?: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface ContestLogbookQsoRow<TFields = Readonly<Record<string, unknown>>> extends ContestWorkbenchQsoRow<TFields> {
  sentExchange?: string;
  receivedExchange?: string;
  operatorCallsign?: string;
  operatorGrid?: string;
  distanceKm?: number;
}

export interface ContestLogbookViewModel<
  TSettings = unknown,
  TScoreDetails = unknown,
  TQsoFields = Readonly<Record<string, unknown>>,
  TImportPreview = unknown,
> extends ContestWorkbenchViewModel<
    TSettings,
    TScoreDetails,
    TQsoFields,
    ContestLogbookReviewIssue,
    TImportPreview
  > {}

export interface ContestLogbookSettingsModule<
  TContest,
  TSession extends VersionedContestSession,
> {
  readonly settings: Record<string, PluginSettingDescriptor>;
  readonly quickSettings?: readonly PluginQuickSetting[];
  seed(contest: TContest, context: ContestSessionContext): TSession;
  validate(
    session: TSession,
    contest: TContest,
    context: ContestSessionContext,
  ): readonly ContestLogbookReviewIssue[];
  title?(contest: TContest, context: ContestSessionContext): string;
}

export interface ContestLogbookImporter<
  TSource,
  TPreview,
  TResult,
> {
  readonly id: string;
  readonly label: string;
  readonly extension: string;
  readonly mediaType?: string;
  readonly accept?: readonly string[];
  preview(
    source: TSource,
    context: PluginUIRequestContext,
  ): Promise<TPreview> | TPreview;
  commit(
    token: string,
    context: PluginUIRequestContext,
  ): Promise<TResult> | TResult;
  cancel?(token: string, context: PluginUIRequestContext): Promise<void> | void;
}

export interface ContestLogbookExporter<TRecord = QSORecord, TOptions = void> {
  readonly id: string;
  readonly label: string;
  readonly extension: string;
  readonly mediaType?: string;
  enabled?(
    context: { contest: unknown; session: unknown },
  ): boolean;
  format(
    records: readonly TRecord[],
    options: TOptions,
  ): string;
}

export interface ContestLogbookAdapter<
  TContest,
  TSession extends VersionedContestSession,
  TSettings,
  TQsoFields = Readonly<Record<string, unknown>>,
  TImportSource = unknown,
  TImportPreview = unknown,
  TExportOptions = void,
  Permissions extends readonly PluginPermission[] = ContestLogbookPermissions,
> {
  readonly settings: ContestLogbookSettingsModule<TContest, TSession>;
  readonly createQsoEnvelope?: ContestQsoEnvelopeAdapter<unknown>;
  readonly importer?: ContestLogbookImporter<TImportSource, TImportPreview, unknown>;
  readonly exporters?: readonly ContestLogbookExporter<TExportOptions>[];
  readonly hooks?: PluginHooks<Permissions>;
  readonly panels?: readonly PluginPanelDescriptor[];
  readonly ui?: {
    readonly dir?: string;
    readonly pages?: readonly PluginUIPageDescriptor[];
  };
  readonly quickSettings?: readonly PluginQuickSetting[];
  getState(
    contest: TContest,
    session: TSession,
    context: PluginContextFor<Permissions>,
  ): ContestLogbookViewModel<TSettings, unknown, TQsoFields, TImportPreview> | Promise<ContestLogbookViewModel<TSettings, unknown, TQsoFields, TImportPreview>>;
  decode(
    action: string,
    data: unknown,
  ): ContestWorkbenchRequest;
  handle(
    request: ContestWorkbenchRequest,
    contest: TContest,
    session: TSession,
    context: PluginUIRequestContext,
  ): unknown | Promise<unknown>;
}

export interface ContestLogbookModule<
  TContest,
  TSession extends VersionedContestSession,
  Permissions extends readonly PluginPermission[] = ContestLogbookPermissions,
> {
  readonly settings?: Record<string, PluginSettingDescriptor>;
  readonly quickSettings?: readonly PluginQuickSetting[];
  readonly session: ContestSessionModule<TContest, ContestLogbookPermissions>;
  readonly workbench: ContestWorkbenchModule<TContest, Permissions>;
  readonly hooks?: PluginHooks<Permissions>;
  readonly panels?: readonly PluginPanelDescriptor[];
  readonly ui?: {
    readonly dir?: string;
    readonly pages?: readonly PluginUIPageDescriptor[];
  };
}

export interface DefaultContestLogbookOptions<
  TContest,
  TSession extends VersionedContestSession,
  TSettings,
  TQsoFields = Readonly<Record<string, unknown>>,
  TImportSource = unknown,
  TImportPreview = unknown,
  TExportOptions = void,
  Permissions extends readonly PluginPermission[] = ContestLogbookPermissions,
> {
  contest: TContest;
  pageId: string;
  adapter: ContestLogbookAdapter<
    TContest,
    TSession,
    TSettings,
    TQsoFields,
    TImportSource,
    TImportPreview,
    TExportOptions,
    Permissions
  >;
}

function defaultContestLogbookStateView(
  contest: { id: string; edition?: { id: string }; rulesetVersion?: string },
  health: ContestSessionHealth,
): ContestLogbookViewModel {
  return {
    schemaVersion: 1,
    contest: {
      id: contest.id,
      editionId: contest.edition?.id ?? '',
      rulesetVersion: contest.rulesetVersion ?? '',
    },
    health,
    settings: { value: {}, valid: true, issues: [] },
    score: { claimedScore: 0, qsoPoints: 0, multiplierCount: 0 },
    qsos: [],
    review: { pendingCount: 0, issues: [] },
    import: { state: 'idle' },
    export: { formats: [] },
  };
}

function resolveQsoBand(record: QSORecord): string | undefined {
  const band = getBandFromFrequency(record.frequency);
  return band === 'Unknown' ? undefined : band.toUpperCase();
}

function adifField(name: string, value: string): string {
  return `<${name}:${value.length}>${value}`;
}

function formatADIFDate(value: number): string {
  const date = new Date(value);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatADIFTime(value: number): string {
  const date = new Date(value);
  return `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function parseADIFFields(record: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<([^:>]+):(\d+)(?::[^>]*)?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(record)) !== null) {
    const length = Number.parseInt(match[2]!, 10);
    const start = match.index + match[0].length;
    fields[match[1]!.trim().toLowerCase()] = record.slice(start, start + length);
  }
  return fields;
}

function splitADIFRecords(content: string): string[] {
  const bodyStart = content.search(/<eoh>/i);
  const body = bodyStart >= 0 ? content.slice(bodyStart + 5) : content;
  return body.split(/<eor>/i).map((value) => value.trim()).filter(Boolean);
}

function parseADIFDateTime(dateStr: string, timeStr: string): number {
  const date = dateStr.trim();
  const time = timeStr.trim().padEnd(6, '0');
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(4, 6), 10) - 1;
  const day = Number.parseInt(date.slice(6, 8), 10);
  const hour = Number.parseInt(time.slice(0, 2), 10);
  const minute = Number.parseInt(time.slice(2, 4), 10);
  const second = Number.parseInt(time.slice(4, 6), 10);
  return Date.UTC(year, month, day, hour, minute, second);
}

function generateADIFFile(records: readonly QSORecord[], options: { programId?: string; includeStationCallsign?: boolean }): string {
  const lines = [`<adif_ver:3>3.1<EOR>`];
  if (options.programId) lines.push(adifField('programid', options.programId));
  lines.push('<eoh>');
  for (const qso of records) {
    const fields: string[] = [];
    fields.push(adifField('qso_date', formatADIFDate(qso.startTime)));
    fields.push(adifField('time_on', formatADIFTime(qso.startTime)));
    fields.push(adifField('freq', (qso.frequency / 1_000_000).toFixed(6)));
    const band = getBandFromFrequency(qso.frequency).toUpperCase();
    if (band && band !== 'UNKNOWN') fields.push(adifField('band', band));
    const mode = qso.mode.trim().toUpperCase();
    if (mode) fields.push(adifField('mode', mode));
    if (qso.submode) fields.push(adifField('submode', qso.submode.trim().toUpperCase()));
    if (qso.grid) fields.push(adifField('gridsquare', qso.grid.trim().toUpperCase().slice(0, 4)));
    if (qso.contestId) fields.push(adifField('contest_id', qso.contestId));
    if (qso.contestEntry) fields.push(adifField('app_tx5dr_contest_entry', JSON.stringify(qso.contestEntry)));
    if (options.includeStationCallsign && qso.myCallsign) fields.push(adifField('station_callsign', qso.myCallsign.trim().toUpperCase()));
    if (qso.myGrid) fields.push(adifField('my_gridsquare', qso.myGrid.trim().toUpperCase().slice(0, 4)));
    if (qso.reportSent) fields.push(adifField('rst_sent', qso.reportSent));
    if (qso.reportReceived) fields.push(adifField('rst_rcvd', qso.reportReceived));
    if (qso.comment) fields.push(adifField('comment', qso.comment));
    lines.push(`${fields.join('')}<eor>`);
  }
  return lines.join('\r\n') + '\r\n';
}

function modeOf(record: QSORecord): 'FT8' | 'FT4' | undefined {
  const mode = record.mode.trim().toUpperCase();
  const submode = record.submode?.trim().toUpperCase();
  if (mode === 'FT8' || submode === 'FT8') return 'FT8';
  if (mode === 'FT4' || submode === 'FT4') return 'FT4';
  return undefined;
}

/**
 * Standard FT8/FT4 record projector that extracts the fields common contest
 * plugins repeatedly need for logbook displays and score summaries.
 */
export function standardFT8ContestQsoAdapter<TFields extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
  options: {
    operatorGrid?(record: QSORecord): string | undefined;
    sentExchange?(record: QSORecord): string | undefined;
    receivedExchange?(record: QSORecord): string | undefined;
  } = {},
): (record: QSORecord) => ContestLogbookQsoRow<TFields> | null {
  return (record) => {
    const band = resolveQsoBand(record);
    const mode = modeOf(record);
    if (!band || !mode) return null;
    const operatorGrid = options.operatorGrid?.(record)?.trim().toUpperCase().slice(0, 4)
      ?? record.myGrid?.trim().toUpperCase().slice(0, 4);
    const receivedExchange = options.receivedExchange?.(record)?.trim().toUpperCase().slice(0, 4)
      ?? record.grid?.trim().toUpperCase().slice(0, 4);
    const sentExchange = options.sentExchange?.(record)?.trim().toUpperCase().slice(0, 4)
      ?? record.myGrid?.trim().toUpperCase().slice(0, 4);
    const fields = {
      frequencyHz: Math.round(record.frequency),
      operatorCallsign: record.myCallsign?.trim().toUpperCase(),
      operatorGrid,
      sentExchange,
      receivedExchange,
      distanceKm: operatorGrid && receivedExchange && /^[A-R]{2}[0-9]{2}$/.test(operatorGrid) && /^[A-R]{2}[0-9]{2}$/.test(receivedExchange)
        ? maidenheadDistanceKm(operatorGrid, receivedExchange)
        : undefined,
    } as const;
    return {
      id: record.id,
      callsign: record.callsign.trim().toUpperCase(),
      band,
      mode,
      time: record.startTime,
      status: record.contestEntry?.annotations?.status === 'excluded'
        ? 'excluded'
        : record.contestEntry?.annotations?.status === 'review'
          ? 'review'
          : 'included',
      fields: fields as unknown as TFields,
      ...fields,
    };
  };
}

export function officialContestExporter<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  options: TSubmissionOptions,
  ): ContestLogbookExporter<TQso, TSubmissionOptions> {
  return {
    id: contest.submission.id,
    label: contest.submission.id,
    extension: contest.submission.extension,
    mediaType: contest.submission.mediaType,
    format(records) {
      return formatFT8ContestSubmission(contest, records as readonly TQso[], options);
    },
  };
}

export function adifContestExporter<TOptions = void>(
  options: {
    id?: string;
    label?: string;
    extension?: string;
    mediaType?: string;
    includeStationCallsign?: boolean;
  } = {},
): ContestLogbookExporter<QSORecord, TOptions> {
  return {
    id: options.id ?? 'adif',
    label: options.label ?? 'ADIF',
    extension: options.extension ?? '.adi',
    mediaType: options.mediaType ?? 'text/plain',
    format(records) {
      return generateADIFFile(records, {
        programId: 'TX5DR-CONTEST-LOGBOOK',
        includeStationCallsign: options.includeStationCallsign ?? true,
      });
    },
  };
}

export function adifContestImporter<
  TPreview,
  TResult,
>(options: {
  id?: string;
  label?: string;
  extension?: string;
  mediaType?: string;
  accept?: readonly string[];
  preview(source: string): TPreview | Promise<TPreview>;
  commit(token: string): TResult | Promise<TResult>;
  cancel?(token: string): Promise<void> | void;
}): ContestLogbookImporter<string, TPreview, TResult> {
  return {
    id: options.id ?? 'adif',
    label: options.label ?? 'ADIF',
    extension: options.extension ?? '.adi',
    mediaType: options.mediaType ?? 'text/plain',
    accept: options.accept ?? ['.adi', '.adif', 'text/plain'],
    preview: options.preview,
    commit: options.commit,
    cancel: options.cancel,
  };
}

/**
 * Generic ADIF parse helper for contest logbooks. Contest plugins still own
 * their validation rules through the callbacks they pass in.
 */
export function parseContestAdifContent(content: string): QSORecord[] {
  return splitADIFRecords(content).map((record, index) => {
    const fields = parseADIFFields(record);
    const date = fields.qso_date ?? fields.qso_date_off;
    const time = fields.time_on ?? fields.time_off;
    if (!date || !time || !fields.call) return null;
    return {
      id: fields.qso_id ?? `contest-adif-${index}`,
      callsign: fields.call.trim().toUpperCase(),
      grid: fields.gridsquare?.trim().toUpperCase().slice(0, 4),
      frequency: Number.parseFloat(fields.freq ?? '0') * 1_000_000,
      mode: fields.mode?.trim().toUpperCase() ?? 'FT8',
      submode: fields.submode?.trim().toUpperCase(),
      startTime: parseADIFDateTime(date, time),
      messageHistory: [],
      comment: fields.comment,
      contestId: fields.contest_id,
      myCallsign: fields.station_callsign?.trim().toUpperCase(),
      myGrid: fields.my_gridsquare?.trim().toUpperCase().slice(0, 4),
    } as QSORecord;
  }).filter((record): record is QSORecord => record !== null);
}

export function projectContestLogbookRows<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  records: readonly TQso[],
): Array<ContestLogbookQsoRow> {
  return projectFT8ContestQsos(contest, records).map((row) => ({
    id: String((row.qso as unknown as { id?: string }).id ?? `${row.qso.callsign}-${row.qso.startTime}`),
    callsign: row.qso.callsign,
    band: row.qso.band,
    mode: row.qso.mode,
    time: row.qso.startTime,
    status: row.qso.status === 'review'
      ? 'review'
      : row.qso.status === 'excluded'
        ? 'excluded'
        : row.qso.status === 'x-qso'
          ? 'x-qso'
          : 'included',
    fields: {
      eligible: row.scoreEligible,
      submissionEligible: row.submissionEligible,
      dupe: row.dupe,
      issues: row.issues,
    },
    sentExchange: undefined,
    receivedExchange: undefined,
    operatorCallsign: undefined,
    operatorGrid: undefined,
    distanceKm: undefined,
  }));
}

export function summarizeContestLogbookScore<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  records: readonly TQso[],
) {
  return scoreFT8ContestQsos(contest, records);
}

export function renderOfficialContestSubmission<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  records: readonly TQso[],
  options: TSubmissionOptions,
): string {
  return formatFT8ContestSubmission(contest, records, options);
}

export function defaultContestLogbook<
  TContest extends ContestSessionIdentity,
  TSession extends VersionedContestSession,
  TSettings,
  TQsoFields = Readonly<Record<string, unknown>>,
  TImportSource = unknown,
  TImportPreview = unknown,
  TExportOptions = void,
  Permissions extends readonly PluginPermission[] = ContestLogbookPermissions,
>(
  options: DefaultContestLogbookOptions<
    TContest,
    TSession,
    TSettings,
    TQsoFields,
    TImportSource,
    TImportPreview,
    TExportOptions,
    Permissions
  >,
): ContestLogbookModule<TContest, TSession, Permissions> {
  const { contest, pageId, adapter } = options;
  const session = defaultContestSession<TContest, TSession>({
    create: (_contest, context) => adapter.settings.seed(_contest, context),
    title: adapter.settings.title,
  });
  const workbench = defaultContestWorkbench({
    pageId,
    getState: ({ contest: currentContest, context }) => {
      const sessionState = session.forOperator(context.operator.id).read();
      return adapter.getState(currentContest, sessionState, context) as ContestLogbookViewModel;
    },
    decode: adapter.decode,
    handle: (request, handlerContext) => adapter.handle(
      request,
      handlerContext.contest,
      session.forOperator(handlerContext.context.operator.id).read(),
      handlerContext.request,
    ),
  } as DefaultContestWorkbenchOptions<TContest, ContestLogbookViewModel, ContestWorkbenchRequest, unknown, Permissions>);
  void contest;
  return {
    settings: adapter.settings.settings,
    quickSettings: adapter.quickSettings ?? adapter.settings.quickSettings,
    session,
    workbench,
    hooks: adapter.hooks,
    panels: adapter.panels,
    ui: adapter.ui,
  };
}
