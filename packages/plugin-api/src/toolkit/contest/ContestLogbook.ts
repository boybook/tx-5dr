import type { PluginPanelDescriptor, PluginPermission, PluginQuickSetting, PluginSettingDescriptor, PluginUIPageDescriptor, QSORecord } from '@tx5dr/contracts';
import { getBandFromFrequency } from '@tx5dr/core';
import type { PluginHooks } from '../../hooks.js';
import type { PluginContextFor, StrategyPluginContext } from '../../context.js';
import type { PluginUIRequestContext } from '../../helpers.js';
import type { VersionedContestSession } from './ContestSessionRepository.js';
import { defaultContestSession, type ContestApplicationSessionFacade, type ContestSessionContext, type ContestSessionIdentity, type ContestSessionStateFacade } from './DefaultContestSession.js';
import { defaultContestWorkbench, type ContestWorkbenchQsoRow, type ContestWorkbenchViewModel, type DefaultContestWorkbenchOptions, type ContestWorkbenchRequest } from './DefaultContestWorkbench.js';
import type { ContestSessionModule, ContestWorkbenchModule } from './FT8ContestPlugin.js';
import type { ContestSessionHealth } from './DefaultContestSession.js';
import type { FT8ContestDefinition } from './FT8ContestDefinition.js';
import { formatFT8ContestSubmission, projectFT8ContestQsos, scoreFT8ContestQsos } from './FT8ContestDefinition.js';
import type { FT8ContestQso } from './FT8ContestModules.js';
import type { ContestQsoEnvelopeAdapter } from './ContestQsoEnvelopeAdapter.js';
import { createContestQsoEnvelopeAdapter } from './ContestQsoEnvelopeAdapter.js';
import { maidenheadDistanceKm } from './FT8ContestModules.js';
import type { StrategyQSOCompletionEffect } from '../../runtime.js';
import type { StrategyMessagePresentationProjection } from '../../runtime.js';
import { CONTEST_WORKBENCH_ACTIONS } from './DefaultContestWorkbench.js';

export const CONTEST_LOGBOOK_PERMISSIONS = [
  'logbook:session',
  'plugin:event-bus',
] as const satisfies readonly PluginPermission[];

export type ContestLogbookPermissions = typeof CONTEST_LOGBOOK_PERMISSIONS;

export const DEFAULT_CONTEST_LOGBOOK_PAGE_ID = 'contest-log';
export const DEFAULT_CONTEST_LOGBOOK_PANEL_ID = 'contest-log';
export const DEFAULT_CONTEST_LOGBOOK_ENTRY = 'contest-log.html';

export interface ContestLogbookUiOptions {
  readonly pageId?: string;
  readonly panelId?: string;
  readonly entry?: string;
  readonly title?: string;
  readonly icon?: string;
  readonly dir?: string;
}

export interface ContestLogbookColumnDescriptor {
  readonly key: string;
  readonly label: string;
}

export interface ContestLogbookSettingField {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly type?: 'string' | 'number' | 'boolean';
  readonly options?: readonly { label: string; value: string }[];
}

export interface ContestLogbookPresentation {
  readonly title?: string;
  readonly columns?: readonly ContestLogbookColumnDescriptor[];
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ContestLogbookContestView {
  readonly id: string;
  readonly editionId: string;
  readonly rulesetVersion: string;
  readonly title?: string;
  readonly officialUrl?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly modes?: readonly string[];
  readonly bands?: readonly string[];
  readonly exchangeId?: string;
  readonly exchangeSummary?: string;
  readonly completionId?: string;
  readonly ruleSummary?: string;
  readonly scoringSummary?: string;
}

export interface ContestLogbookScoreDetails {
  readonly moduleId?: string;
  readonly summary?: string;
  readonly qsoCount?: number;
  readonly multiplierCount?: number;
  readonly total?: number;
}

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
  qsoId?: string;
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
  > {
  readonly contest: ContestLogbookContestView;
  readonly score: ContestWorkbenchViewModel<TSettings, TScoreDetails, TQsoFields, ContestLogbookReviewIssue, TImportPreview>['score'] & {
    readonly details?: TScoreDetails;
  };
  readonly settings: ContestWorkbenchViewModel<TSettings, TScoreDetails, TQsoFields, ContestLogbookReviewIssue, TImportPreview>['settings'] & {
    readonly fields?: readonly ContestLogbookSettingField[];
  };
  readonly columns?: readonly ContestLogbookColumnDescriptor[];
  readonly presentation?: ContestLogbookPresentation;
}

export interface StandardContestLogbookSession extends VersionedContestSession {
  readonly settings: Readonly<Record<string, unknown>>;
}

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
  readonly exporters?: readonly ContestLogbookExporter<unknown, unknown>[];
  readonly hooks?: PluginHooks<Permissions>;
  readonly panels?: readonly PluginPanelDescriptor[];
  readonly ui?: {
    readonly dir?: string;
    readonly pages?: readonly PluginUIPageDescriptor[];
  };
  readonly quickSettings?: readonly PluginQuickSetting[];
  /** Builds the Host-evaluated decoded-message presentation from contest-session records. */
  messagePresentation?(
    contest: TContest,
    context: PluginContextFor<Permissions>,
    records: readonly QSORecord[],
  ): StrategyMessagePresentationProjection | undefined;
  decorateRecord?(record: QSORecord, contest: TContest, context: StrategyPluginContext): QSORecord;
  readonly presentation?: ContestLogbookPresentation;
  projectQso?(record: QSORecord, contest: TContest, context: PluginContextFor<Permissions>): FT8ContestQso<unknown> | null;
  getState(
    contest: TContest,
    session: TSession,
    context: PluginContextFor<Permissions>,
    records?: readonly QSORecord[],
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
    application?: ContestApplicationSessionFacade,
    records?: readonly QSORecord[],
    state?: ContestSessionStateFacade<TSession>,
    pluginContext?: PluginContextFor<Permissions>,
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
  /** Returns the latest independent contest-session presentation for an operator. */
  readonly getMessagePresentation?: (operatorId: string) => StrategyMessagePresentationProjection | undefined;
  readonly decorateCompletion?: (
    effect: StrategyQSOCompletionEffect,
    context: StrategyPluginContext,
  ) => StrategyQSOCompletionEffect;
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
  pageId?: string;
  ui?: false | ContestLogbookUiOptions;
  resolveContest?(context: ContestSessionContext): TContest;
  sessionKey?(contest: TContest, context: ContestSessionContext): string;
  stateKey?(contest: TContest, context: ContestSessionContext): string;
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

function mergeArrayById<T extends { id: string }>(first?: readonly T[], second?: readonly T[]): T[] | undefined {
  const result: T[] = [];
  const positions = new Map<string, number>();
  for (const item of [...first ?? [], ...second ?? []]) {
    const existing = positions.get(item.id);
    if (existing === undefined) {
      positions.set(item.id, result.length);
      result.push(item);
    } else {
      result[existing] = item;
    }
  }
  return result.length > 0 ? result : undefined;
}

function createImportToken(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) return randomUUID.call(globalThis.crypto);
  return `contest-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const { contest, adapter } = options;
  const activeContests = new Map<string, TContest>();
  const messagePresentations = new Map<string, StrategyMessagePresentationProjection>();
  const pageId = options.pageId
    ?? (options.ui !== false ? options.ui?.pageId : undefined)
    ?? DEFAULT_CONTEST_LOGBOOK_PAGE_ID;
  const uiOptions = options.ui === false ? undefined : options.ui ?? {};
  const defaultPage = uiOptions ? {
    id: pageId,
    title: uiOptions.title ?? 'contestLogTitle',
    entry: uiOptions.entry ?? DEFAULT_CONTEST_LOGBOOK_ENTRY,
    icon: uiOptions.icon,
    accessScope: 'operator' as const,
    resourceBinding: 'operator' as const,
  } : undefined;
  const defaultPanel = uiOptions ? {
    id: uiOptions.panelId ?? DEFAULT_CONTEST_LOGBOOK_PANEL_ID,
    title: uiOptions.title ?? 'contestLogTitle',
    component: 'iframe' as const,
    pageId,
    slot: 'operator-action' as const,
    openMode: 'page' as const,
    icon: uiOptions.icon ?? 'file-lines',
  } : undefined;
  const customPages = options.ui === false ? [] : adapter.ui?.pages ?? [];
  const customPanels = options.ui === false ? [] : adapter.panels ?? [];
  const pages = mergeArrayById(
    defaultPage ? [defaultPage] : undefined,
    customPages,
  );
  const panels = mergeArrayById<PluginPanelDescriptor>(
    defaultPanel ? [defaultPanel as PluginPanelDescriptor] : undefined,
    customPanels,
  );
  const sessionBase = defaultContestSession<TContest, TSession>({
    create: (_contest, context) => adapter.settings.seed(_contest, context),
    sessionKey: options.sessionKey,
    stateKey: options.stateKey,
    title: adapter.settings.title,
  });
  const refreshMessagePresentation = async (
    operatorId: string,
    context: PluginContextFor<Permissions>,
    effectiveContest: TContest,
    records?: readonly QSORecord[],
  ): Promise<void> => {
    if (!adapter.messagePresentation) return;
    try {
      const snapshotRecords = records ?? (await sessionBase.access(context as ContestSessionContext).snapshot()).records;
      const projection = adapter.messagePresentation(effectiveContest, context, snapshotRecords);
      if (projection) messagePresentations.set(operatorId, projection);
      else messagePresentations.delete(operatorId);
    } catch (error) {
      context.log.debug('Contest message presentation refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const session: ContestSessionModule<TContest, ContestLogbookPermissions> = {
    id: sessionBase.id,
    async setup(input) {
      const effectiveContest = options.resolveContest?.(input.context) ?? input.contest;
      activeContests.set(input.context.operator.id, effectiveContest);
      const cleanup = await sessionBase.setup({ ...input, contest: effectiveContest });
      await refreshMessagePresentation(
        input.context.operator.id,
        input.context as unknown as PluginContextFor<Permissions>,
        effectiveContest,
      );
      if (!cleanup) return cleanup;
      return async (context) => {
        try {
          await cleanup(context);
        } finally {
          activeContests.delete(context.operator.id);
          messagePresentations.delete(context.operator.id);
        }
      };
    },
  };
  const workbench = defaultContestWorkbench({
    pageId,
    getState: async ({ contest: currentContest, context }) => {
      const effectiveContest = activeContests.get(context.operator.id) ?? currentContest;
      const sessionState = sessionBase.forOperator(context.operator.id).read();
      const snapshot = await sessionBase.access(context as ContestSessionContext).snapshot();
      await refreshMessagePresentation(context.operator.id, context, effectiveContest, snapshot.records);
      const state = await adapter.getState(effectiveContest, sessionState, context, snapshot.records) as ContestLogbookViewModel;
      const hostHealth = sessionBase.getHealth(context.operator.id);
      return {
        ...state,
        health: hostHealth.state === 'healthy' ? state.health : hostHealth,
        settings: {
          ...state.settings,
          fields: state.settings.fields ?? Object.entries(adapter.settings.settings).map(([key, descriptor]) => ({
            key,
            label: descriptor.label,
            description: descriptor.description,
            type: descriptor.type === 'boolean' || descriptor.type === 'number' ? descriptor.type : 'string',
            options: descriptor.options,
          })),
        },
        presentation: state.presentation ?? adapter.presentation,
      };
    },
    decode: adapter.decode,
    handle: async (request, handlerContext) => {
      const effectiveContest = activeContests.get(handlerContext.context.operator.id) ?? handlerContext.contest;
      const result = await adapter.handle(
        request,
        effectiveContest,
        sessionBase.forOperator(handlerContext.context.operator.id).read(),
        handlerContext.request,
        sessionBase.access(handlerContext.context as ContestSessionContext),
        undefined,
        sessionBase.forOperator(handlerContext.context.operator.id),
        handlerContext.context,
      );
      await refreshMessagePresentation(handlerContext.context.operator.id, handlerContext.context, effectiveContest);
      return result;
    },
  } as DefaultContestWorkbenchOptions<TContest, ContestLogbookViewModel, ContestWorkbenchRequest, unknown, Permissions>);
  const hooks: PluginHooks<Permissions> = {
    ...adapter.hooks,
    async onQSOComplete(record, context) {
      await adapter.hooks?.onQSOComplete?.(record, context);
      await refreshMessagePresentation(context.operator.id, context, activeContests.get(context.operator.id) ?? contest);
      try {
        await sessionBase.access(context as ContestSessionContext).notify('transaction');
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'contest_session_not_open') throw error;
        context.log.debug('Contest logbook session is not open during QSO notification');
      }
      for (const page of context.ui.listActivePageSessions(pageId)) {
        context.ui.pushToSession(page.sessionId, 'stateChanged');
      }
      context.ui.refreshOperatorProjection();
    },
    async onConfigChange(changes, context) {
      await adapter.hooks?.onConfigChange?.(changes, context);
      if (options.resolveContest) {
        const effectiveContest = options.resolveContest(context as ContestSessionContext);
        activeContests.set(context.operator.id, effectiveContest);
        await sessionBase.rebind(context.operator.id, effectiveContest, context as ContestSessionContext);
        await refreshMessagePresentation(context.operator.id, context, effectiveContest);
      }
      for (const page of context.ui.listActivePageSessions(pageId)) {
        context.ui.pushToSession(page.sessionId, 'stateChanged');
      }
      context.ui.refreshOperatorProjection();
    },
  };
  void contest;
  return {
    settings: adapter.settings.settings,
    quickSettings: adapter.quickSettings ?? adapter.settings.quickSettings,
    session,
    workbench,
    hooks,
    panels,
    ui: options.ui === false ? undefined : pages || adapter.ui || uiOptions ? {
      dir: uiOptions?.dir ?? adapter.ui?.dir ?? 'ui',
      pages,
    } : undefined,
    getMessagePresentation(operatorId) {
      return messagePresentations.get(operatorId);
    },
    decorateCompletion(effect, context) {
      const record = adapter.decorateRecord?.(effect.record, contest, context) ?? effect.record;
      return {
        ...effect,
        record,
        destination: effect.destination ?? sessionBase.getDestination(context.operator.id),
      };
    },
  };
}

export interface StandardFT8ContestLogbookOptions<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
> {
  readonly contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>;
  readonly pageId?: string;
  readonly ui?: false | ContestLogbookUiOptions;
  readonly settings?: ContestLogbookSettingsModule<FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>, StandardContestLogbookSession>;
  projectQso?(record: QSORecord, context: ContestSessionContext): TQso | null;
  decorateRecord?(record: QSORecord, context: StrategyPluginContext): QSORecord;
  readonly presentation?: ContestLogbookPresentation;
  readonly submissionOptions?: TSubmissionOptions;
  resolveContest?(context: ContestSessionContext): FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>;
  sessionKey?(contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>, context: ContestSessionContext): string;
  stateKey?(contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>, context: ContestSessionContext): string;
}

function standardContestQso<TExchange, TQso extends FT8ContestQso<TExchange>>(
  contest: FT8ContestDefinition<TExchange, TQso, unknown>,
  record: QSORecord,
): TQso | null {
  const band = resolveQsoBand(record);
  const mode = modeOf(record);
  if (!band || !mode) return null;
  const entry = record.contestEntry;
  const sentFields = entry?.sent as Record<string, string> | undefined
    ?? { grid: record.myGrid?.trim().toUpperCase() ?? '' };
  const receivedFields = entry?.received as Record<string, string> | undefined
    ?? { grid: record.grid?.trim().toUpperCase() ?? '' };
  const sent = contest.exchange.decode(sentFields);
  const received = contest.exchange.decode(receivedFields);
  const operatorGrid = record.myGrid?.trim().toUpperCase().slice(0, 4);
  const receivedGrid = typeof receivedFields.grid === 'string'
    ? receivedFields.grid.trim().toUpperCase().slice(0, 4)
    : undefined;
  const status = entry?.annotations?.status === 'excluded'
    ? 'excluded'
    : entry?.annotations?.status === 'x-qso'
      ? 'x-qso'
      : entry?.annotations?.status === 'review' || !sent.ok || !received.ok
        ? 'review'
        : 'included';
  return {
    qsoId: record.id,
    callsign: record.callsign.trim().toUpperCase(),
    band,
    mode,
    startTime: record.startTime,
    status,
    sentExchange: sent.ok ? sent.value : undefined,
    receivedExchange: received.ok ? received.value : undefined,
    operatorCallsign: record.myCallsign?.trim().toUpperCase() ?? '',
    operatorGrid,
    distanceKm: operatorGrid && receivedGrid
      ? maidenheadDistanceKm(operatorGrid, receivedGrid)
      : undefined,
  } as unknown as TQso;
}

type StandardContestQso = FT8ContestQso<unknown> & {
  operatorCallsign?: string;
  operatorGrid?: string;
};

function standardContestRecordRow(
  projected: {
    qso: StandardContestQso;
    issues: readonly string[];
    scoreEligible: boolean;
    submissionEligible: boolean;
    dupe: boolean;
  },
  record: QSORecord,
): ContestLogbookQsoRow {
  const qso = projected.qso;
  return {
    id: record.id,
    callsign: qso.callsign,
    band: qso.band,
    mode: qso.mode,
    time: qso.startTime,
    status: qso.status === 'review' || projected.issues.includes('review')
      ? 'review'
      : qso.status === 'excluded'
        ? 'excluded'
        : qso.status === 'x-qso'
          ? 'x-qso'
          : 'included',
    sentExchange: qso.sentExchange ? JSON.stringify(qso.sentExchange) : undefined,
    receivedExchange: qso.receivedExchange ? JSON.stringify(qso.receivedExchange) : undefined,
    operatorCallsign: qso.operatorCallsign,
    operatorGrid: qso.operatorGrid,
    distanceKm: qso.distanceKm,
    fields: {
      eligible: projected.scoreEligible,
      submissionEligible: projected.submissionEligible,
      dupe: projected.dupe,
      issues: projected.issues,
    },
  };
}

function gridField(exchange: unknown): string | undefined {
  if (!exchange || typeof exchange !== 'object') return undefined;
  const value = (exchange as { grid?: unknown }).grid;
  if (typeof value !== 'string') return undefined;
  const field = value.trim().toUpperCase().slice(0, 2);
  return /^[A-R]{2}$/.test(field) ? field : undefined;
}

function standardContestMessagePresentation<TExchange, TQso extends FT8ContestQso<TExchange>>(
  contest: FT8ContestDefinition<TExchange, TQso, unknown>,
  records: readonly QSORecord[],
  project: (record: QSORecord) => TQso | null,
  revision: number,
): StrategyMessagePresentationProjection {
  const workedByBand = new Map<string, Set<string>>();
  const workedFieldsByBand = new Map<string, Set<string>>();
  for (const record of records) {
    const qso = project(record);
    if (!qso || qso.status === 'x-qso') continue;
    const callsign = qso.callsign.trim().toUpperCase();
    const band = qso.band.trim().toUpperCase();
    if (!callsign || !band) continue;
    const worked = workedByBand.get(band) ?? new Set<string>();
    worked.add(callsign);
    workedByBand.set(band, worked);
    const field = gridField(qso.receivedExchange);
    if (field) {
      const fields = workedFieldsByBand.get(band) ?? new Set<string>();
      fields.add(field);
      workedFieldsByBand.set(band, fields);
    }
  }
  const asRecord = (values: Map<string, Set<string>>): Record<string, string[]> => Object.fromEntries(
    [...values].map(([key, entries]) => [key, [...entries].sort()]),
  );
  const bandAssignments = [...workedByBand].flatMap(([band, callsigns]) => [...callsigns].map((subject) => ({
    subject,
    partition: band,
    classId: 'contest-worked',
  })));
  return {
    revision,
    mode: 'replace-logbook',
    subject: 'sender-callsign',
    partitionBy: 'band',
    eligiblePartitions: contest.bands.map((band) => band.toUpperCase()),
    defaultClass: 'contest-new-call',
    classes: {
      'contest-new-field': {
        badges: [{ label: 'contestNewMultiplier', tone: 'secondary' }],
        row: { tone: 'secondary', background: 'soft', accent: true },
        emphasisWhen: [{ firstTokenIn: ['CQ'] }, { anyTokenIn: ['RR73', 'RRR', '73'] }],
      },
      'contest-new-call': {
        badges: [{ label: 'contestNewCallsign', tone: 'warning' }],
        row: { tone: 'warning', background: 'soft', accent: true },
        emphasisWhen: [{ firstTokenIn: ['CQ'] }, { anyTokenIn: ['RR73', 'RRR', '73'] }],
      },
      'contest-worked': { textDecoration: 'line-through', opacity: 'muted' },
    },
    assignments: bandAssignments,
    noveltyRules: [{
      fact: 'grid-field-2',
      knownValuesByPartition: asRecord(workedFieldsByBand),
      classId: 'contest-new-field',
    }],
  };
}

function decodeStandardContestAction(action: string, data: unknown): ContestWorkbenchRequest {
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  if (action === CONTEST_WORKBENCH_ACTIONS.saveSettings) return { action, payload };
  if (action === CONTEST_WORKBENCH_ACTIONS.setQsoStatus) {
    if (typeof payload.qsoId !== 'string' || !['included', 'review', 'excluded', 'x-qso'].includes(String(payload.status))) {
      throw new Error('contest_logbook_invalid_qso_status_request');
    }
    return { action, payload: { qsoId: payload.qsoId, status: payload.status } };
  }
  if (action === CONTEST_WORKBENCH_ACTIONS.previewImport) {
    if (typeof payload.path !== 'string' || !payload.path.startsWith('imports/')) throw new Error('contest_logbook_invalid_import_path');
    return { action, payload: { path: payload.path, fileName: typeof payload.fileName === 'string' ? payload.fileName : 'log.adi' } };
  }
  if (action === CONTEST_WORKBENCH_ACTIONS.commitImport || action === 'cancel-import') {
    if (typeof payload.token !== 'string' || !payload.token) throw new Error('contest_logbook_import_token_required');
    return { action, payload: { token: payload.token } };
  }
  if (action === CONTEST_WORKBENCH_ACTIONS.export) {
    if (typeof payload.formatId !== 'string' || !payload.formatId) throw new Error('contest_logbook_export_format_required');
    return { action, payload: { formatId: payload.formatId } };
  }
  throw new Error(`contest_logbook_unknown_action:${action}`);
}

export function standardFT8ContestLogbook<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
>(
  options: StandardFT8ContestLogbookOptions<TExchange, TQso, TSubmissionOptions>,
): ContestLogbookModule<
  FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  StandardContestLogbookSession,
  ContestLogbookPermissions
> {
  const { contest } = options;
  const project = (record: QSORecord, context: ContestSessionContext): TQso | null => (
    options.projectQso?.(record, context) ?? standardContestQso(contest as FT8ContestDefinition<TExchange, TQso, unknown>, record) as TQso | null
  );
  const envelope = createContestQsoEnvelopeAdapter(contest);
  const pending = new Map<string, { operatorId: string; pageSessionId: string; records: QSORecord[]; createdAt: number }>();
  const settings = options.settings ?? {
    settings: {},
    seed: () => ({ schemaVersion: 1, revision: 0, settings: {} }),
    validate: () => [],
  } satisfies ContestLogbookSettingsModule<typeof contest, StandardContestLogbookSession>;
  const columns = options.presentation?.columns ?? [
    { key: 'callsign', label: 'Callsign' },
    { key: 'band', label: 'Band' },
    { key: 'mode', label: 'Mode' },
    { key: 'time', label: 'Time' },
    { key: 'receivedExchange', label: 'Exchange' },
  ];
  const exporters: ContestLogbookExporter<unknown, unknown>[] = [
    adifContestExporter() as unknown as ContestLogbookExporter<unknown, unknown>,
    officialContestExporter(contest, options.submissionOptions as TSubmissionOptions) as unknown as ContestLogbookExporter<unknown, unknown>,
  ];
  const presentationRevisions = new Map<string, number>();

  const adapter: ContestLogbookAdapter<
    typeof contest,
    StandardContestLogbookSession,
    Readonly<Record<string, unknown>>,
    Readonly<Record<string, unknown>>,
    string,
    Readonly<Record<string, unknown>>,
    TSubmissionOptions
  > = {
    settings,
    createQsoEnvelope: envelope,
    exporters,
    messagePresentation(currentContest, context, records) {
      const operatorId = context.operator.id;
      const revision = (presentationRevisions.get(operatorId) ?? 0) + 1;
      presentationRevisions.set(operatorId, revision);
      return standardContestMessagePresentation(
        currentContest as FT8ContestDefinition<TExchange, TQso, unknown>,
        records,
        (record) => project(record, context as ContestSessionContext),
        revision,
      );
    },
    presentation: { ...options.presentation, columns },
    getState(currentContest, session, context, records = []) {
      const projected = records.flatMap((record) => {
        const qso = project(record, context as ContestSessionContext);
        return qso ? [{ record, qso }] : [];
      });
      const projection = projectFT8ContestQsos(currentContest, projected.map(({ qso }) => qso as TQso));
      const recordsById = new Map(projected.map((entry) => [
        (entry.qso as TQso & { qsoId?: string }).qsoId,
        entry.record,
      ]));
      const rows = projection.map((item) => {
        const qso = item.qso as TQso & { qsoId?: string };
        return standardContestRecordRow(item as unknown as Parameters<typeof standardContestRecordRow>[0], recordsById.get(qso.qsoId) ?? projected[0]!.record);
      });
      const score = scoreFT8ContestQsos(currentContest, projected.map(({ qso }) => qso as TQso));
      const issues = projection.flatMap((item, index) => item.issues.map((code) => ({
        code,
        message: code,
        qsoId: projected[index]?.record.id,
        severity: code === 'review' || code === 'dupe' ? 'warning' as const : 'info' as const,
      })));
      return {
        schemaVersion: 1,
        contest: {
          id: currentContest.id,
          editionId: currentContest.edition.id,
          rulesetVersion: currentContest.rulesetVersion,
          title: currentContest.presentation?.title,
          officialUrl: currentContest.edition.source?.url,
          startAt: currentContest.edition.startAt,
          endAt: currentContest.edition.endAt,
          modes: [...currentContest.modes],
          bands: [...currentContest.bands],
          exchangeId: currentContest.exchange.id,
          exchangeSummary: currentContest.presentation?.exchange,
          completionId: currentContest.completion.id,
          ruleSummary: currentContest.presentation?.summary ?? `${currentContest.modes.join('/')} contest using ${currentContest.exchange.id} exchange`,
          scoringSummary: currentContest.presentation?.scoring ?? `Scoring module: ${currentContest.scoring.id}`,
        },
        health: { state: 'healthy' as const, readable: true, writable: true, updatedAt: Date.now() },
        settings: {
          value: session.settings,
          valid: settings.validate(session, currentContest, context as ContestSessionContext).length === 0,
          issues: settings.validate(session, currentContest, context as ContestSessionContext).map((issue) => issue.message),
          fields: Object.entries(settings.settings).map(([key, descriptor]) => ({
            key,
            label: descriptor.label,
            description: descriptor.description,
            type: descriptor.type === 'number' || descriptor.type === 'boolean' ? descriptor.type : 'string',
            options: descriptor.options,
          })),
        },
        score: {
          claimedScore: score.total,
          qsoPoints: score.qsoPoints,
          multiplierCount: score.multiplierCount,
          details: {
            moduleId: currentContest.scoring.id,
            summary: currentContest.presentation?.scoring ?? `Scoring module: ${currentContest.scoring.id}`,
            qsoCount: score.qsoCount,
            multiplierCount: score.multiplierCount,
            total: score.total,
          },
        },
        qsos: rows,
        review: { pendingCount: rows.filter((row) => row.status === 'review').length, issues },
        import: { state: 'idle' as const },
        export: { formats: exporters.map((item) => ({ id: item.id, label: item.label, extension: item.extension, enabled: item.enabled?.({ contest: currentContest, session }) ?? true })) },
        columns,
        presentation: options.presentation,
      };
    },
    decode: decodeStandardContestAction,
    async handle(request, currentContest, session, requestContext, application, records, state, pluginContext) {
      if (request.action === CONTEST_WORKBENCH_ACTIONS.saveSettings) {
        const nextSettings = request.payload as Readonly<Record<string, unknown>>;
        const next = { ...session, settings: nextSettings };
        const issues = settings.validate(next, currentContest, pluginContext as ContestSessionContext);
        if (issues.length > 0) throw new Error(`contest_logbook_invalid_settings:${issues.map((issue) => issue.code).join(',')}`);
        state?.update(() => next);
        await state?.flush();
        await application?.notify('manual');
        return { saved: true };
      }
      if (!application) throw new Error('contest_logbook_session_unavailable');
      if (request.action === CONTEST_WORKBENCH_ACTIONS.setQsoStatus) {
        const payload = request.payload as { qsoId: string; status: string };
        await application.transact((snapshot) => {
          const current = snapshot.records.find((record) => record.id === payload.qsoId);
          if (!current) throw new Error('contest_logbook_qso_not_found');
          const contestEntry = current.contestEntry ? {
            ...current.contestEntry,
            annotations: { ...current.contestEntry.annotations, status: payload.status },
          } : undefined;
          return [{ type: 'update', qsoId: current.id, updates: { ...(contestEntry ? { contestEntry } : {}), contestId: current.contestId ?? currentContest.id } }];
        }, { reason: 'review' });
        return { updated: true };
      }
      if (request.action === CONTEST_WORKBENCH_ACTIONS.previewImport) {
        const payload = request.payload as { path: string; fileName: string };
        const source = await requestContext.files.read(payload.path);
        await requestContext.files.delete(payload.path).catch(() => false);
        if (!source) throw new Error('contest_logbook_import_file_missing');
        const imported = parseContestAdifContent(source.toString('utf8'));
        const token = createImportToken();
        pending.set(token, { operatorId: requestContext.instanceTarget.kind === 'operator' ? requestContext.instanceTarget.operatorId : '', pageSessionId: requestContext.pageSessionId, records: imported, createdAt: Date.now() });
        const importProjection = imported.map((record) => project(record, pluginContext as ContestSessionContext));
        const importable = importProjection.filter(Boolean).length;
        return { token, fileName: payload.fileName, preview: { totalRead: imported.length, importable, review: importProjection.filter((qso) => qso?.status === 'review').length, duplicates: 0, rejected: imported.length - importable } };
      }
      if (request.action === 'cancel-import') {
        pending.delete((request.payload as { token: string }).token);
        return { cancelled: true };
      }
      if (request.action === CONTEST_WORKBENCH_ACTIONS.commitImport) {
        const token = (request.payload as { token: string }).token;
        const entry = pending.get(token);
        if (!entry || entry.operatorId !== (requestContext.instanceTarget.kind === 'operator' ? requestContext.instanceTarget.operatorId : '') || entry.pageSessionId !== requestContext.pageSessionId || Date.now() - entry.createdAt > 15 * 60_000) throw new Error('contest_logbook_import_preview_expired');
        await application.transact((snapshot) => {
          const existing = new Set(snapshot.records.map((record) => `${record.callsign}:${record.startTime}:${record.frequency}`));
          return entry.records.flatMap((record) => {
            if (!project(record, pluginContext as ContestSessionContext)) return [];
            const decorated = options.decorateRecord?.(record, pluginContext as StrategyPluginContext) ?? record;
            const key = `${decorated.callsign}:${decorated.startTime}:${decorated.frequency}`;
            return existing.has(key) ? [] : [{ type: 'add', record: decorated }];
          });
        }, { reason: 'import' });
        pending.delete(token);
        return { imported: entry.records.length };
      }
      if (request.action === CONTEST_WORKBENCH_ACTIONS.export) {
        const formatId = (request.payload as { formatId: string }).formatId;
        const exporter = exporters.find((item) => item.id === formatId);
        if (!exporter) throw new Error('contest_logbook_export_format_unknown');
        const all = await application.query();
        const projected = all.flatMap((record) => { const qso = project(record, pluginContext as ContestSessionContext); return qso ? [{ record, qso }] : []; });
        const exportRecords = formatId === 'adif' ? all : projected.map(({ qso }) => qso as TQso);
        return { fileName: `contest-${currentContest.id}.${exporter.extension.replace(/^\./, '')}`, mediaType: exporter.mediaType ?? 'text/plain', text: exporter.format(exportRecords as never, options.submissionOptions as never) };
      }
      throw new Error(`contest_logbook_unknown_action:${request.action}`);
    },
    decorateRecord(record, _currentContest, context) {
      if (options.decorateRecord) return options.decorateRecord(record, context);
      const qso = project(record, context as ContestSessionContext);
      if (!qso?.sentExchange || !qso.receivedExchange) return { ...record, contestId: contest.id };
      return {
        ...record,
        contestId: contest.id,
        contestEntry: envelope.create({
          sent: qso.sentExchange,
          received: qso.receivedExchange,
          annotations: { status: qso.status ?? 'included', source: 'contest-logbook' },
        }),
      };
    },
  };
  const module = defaultContestLogbook({
    contest,
    pageId: options.pageId,
    ui: options.ui,
    resolveContest: options.resolveContest,
    sessionKey: options.sessionKey,
    stateKey: options.stateKey,
    adapter,
  });
  return module;
}
