import type { PluginPermission } from '@tx5dr/contracts';
import type { PluginContextFor } from '../../context.js';
import type { PluginUIRequestContext } from '../../helpers.js';
import type { ContestSessionHealth } from './DefaultContestSession.js';
import type { ContestWorkbenchModule } from './FT8ContestPlugin.js';

export const CONTEST_WORKBENCH_ACTIONS = {
  getState: 'get-state',
  saveSettings: 'save-settings',
  setQsoStatus: 'set-qso-status',
  previewImport: 'preview-import',
  commitImport: 'commit-import',
  export: 'export',
} as const;

export type ContestWorkbenchAction =
  typeof CONTEST_WORKBENCH_ACTIONS[keyof typeof CONTEST_WORKBENCH_ACTIONS];

export type ContestWorkbenchQsoStatus = 'included' | 'review' | 'excluded' | 'x-qso';

export interface ContestWorkbenchSettingsView<TSettings = unknown> {
  value: TSettings;
  valid: boolean;
  issues: readonly string[];
}

export interface ContestWorkbenchScoreView<TDetails = unknown> {
  claimedScore: number;
  qsoPoints: number;
  multiplierCount: number;
  details?: TDetails;
}

export interface ContestWorkbenchQsoRow<TFields = Readonly<Record<string, unknown>>> {
  id: string;
  callsign: string;
  band: string;
  mode: 'FT8' | 'FT4';
  time: number;
  status: ContestWorkbenchQsoStatus;
  fields: TFields;
}

export interface ContestWorkbenchReviewView<TIssue = unknown> {
  pendingCount: number;
  issues: readonly TIssue[];
}

export interface ContestWorkbenchImportView<TPreview = unknown> {
  state: 'idle' | 'preview' | 'committing' | 'complete' | 'error';
  token?: string;
  preview?: TPreview;
  error?: string;
}

export interface ContestWorkbenchExportFormat {
  id: string;
  label: string;
  extension: string;
  enabled: boolean;
}

/** Stable outer page state; plugins own the contest-specific generic fields. */
export interface ContestWorkbenchViewModel<
  TSettings = unknown,
  TScoreDetails = unknown,
  TQsoFields = Readonly<Record<string, unknown>>,
  TReviewIssue = unknown,
  TImportPreview = unknown,
> {
  schemaVersion: 1;
  contest: {
    id: string;
    editionId: string;
    rulesetVersion: string;
  };
  health: ContestSessionHealth;
  settings: ContestWorkbenchSettingsView<TSettings>;
  score: ContestWorkbenchScoreView<TScoreDetails>;
  qsos: readonly ContestWorkbenchQsoRow<TQsoFields>[];
  review: ContestWorkbenchReviewView<TReviewIssue>;
  import: ContestWorkbenchImportView<TImportPreview>;
  export: { formats: readonly ContestWorkbenchExportFormat[] };
}

export interface ContestWorkbenchRequest<TAction extends string = string, TPayload = unknown> {
  action: TAction;
  payload: TPayload;
}

/** Shared command names; parsers still validate each contest-specific payload. */
export type ContestWorkbenchCommand<TSettings = unknown, TImportSource = unknown> =
  | ContestWorkbenchRequest<typeof CONTEST_WORKBENCH_ACTIONS.saveSettings, TSettings>
  | ContestWorkbenchRequest<
      typeof CONTEST_WORKBENCH_ACTIONS.setQsoStatus,
      { qsoId: string; status: ContestWorkbenchQsoStatus }
    >
  | ContestWorkbenchRequest<typeof CONTEST_WORKBENCH_ACTIONS.previewImport, TImportSource>
  | ContestWorkbenchRequest<typeof CONTEST_WORKBENCH_ACTIONS.commitImport, { token: string }>
  | ContestWorkbenchRequest<typeof CONTEST_WORKBENCH_ACTIONS.export, { formatId: string }>;

export interface ContestWorkbenchHandlerContext<
  TContest,
  Permissions extends readonly PluginPermission[],
> {
  contest: TContest;
  context: PluginContextFor<Permissions>;
  request: PluginUIRequestContext;
}

export interface DefaultContestWorkbenchOptions<
  TContest,
  TState extends ContestWorkbenchViewModel,
  TRequest extends ContestWorkbenchRequest,
  TResult,
  Permissions extends readonly PluginPermission[] = readonly [],
> {
  pageId: string;
  getState(
    context: ContestWorkbenchHandlerContext<TContest, Permissions>,
  ): TState | Promise<TState>;
  /** Validates untrusted iframe data and returns a typed request union. */
  decode(action: string, data: unknown): TRequest;
  handle(
    request: TRequest,
    context: ContestWorkbenchHandlerContext<TContest, Permissions>,
  ): TResult | Promise<TResult>;
}

/**
 * Registers one narrow page protocol: `get-state` plus plugin-decoded commands.
 * Rendering, fields and contest-specific actions remain owned by the plugin.
 */
export function defaultContestWorkbench<
  TContest,
  TState extends ContestWorkbenchViewModel,
  TRequest extends ContestWorkbenchRequest,
  TResult,
  Permissions extends readonly PluginPermission[] = readonly [],
>(
  options: DefaultContestWorkbenchOptions<TContest, TState, TRequest, TResult, Permissions>,
): ContestWorkbenchModule<TContest, Permissions> {
  return {
    id: 'default-contest-workbench',
    setup({ contest, context }) {
      context.ui.registerPageHandler({
        async onMessage(pageId, action, data, request) {
          if (pageId !== options.pageId) throw new Error('contest_workbench_page_mismatch');
          const handlerContext = { contest, context, request };
          if (action === CONTEST_WORKBENCH_ACTIONS.getState) return options.getState(handlerContext);
          const decoded = options.decode(action, data);
          if (decoded.action !== action) throw new Error('contest_workbench_action_mismatch');
          return options.handle(decoded, handlerContext);
        },
      }, { pageIds: [options.pageId] });
    },
  };
}
