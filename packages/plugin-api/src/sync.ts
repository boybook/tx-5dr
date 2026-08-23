/**
 * Logbook sync provider interfaces.
 *
 * A utility plugin registers a sync provider via `ctx.logbookSync.register()`
 * during `onLoad`. The host manages per-callsign lifecycle, auto-upload on QSO
 * completion, and renders the provider's settings page in the sync modal.
 * Registration requires a global API v2 utility with `logbook:sync`; the
 * referenced settings page must use `resourceBinding: 'callsign'`.
 */

// ===== Provider interface =====

/**
 * A logbook sync provider implements the communication logic with a single
 * external log service (e.g. LoTW, QRZ.com, WaveLog).
 *
 * All methods receive a `callsign` parameter because sync configuration and
 * data are organized per-callsign. The provider is responsible for managing
 * its own per-callsign state (typically via `ctx.store.global` keyed by
 * callsign).
 *
 * A typical provider declares `network`, `logbook:read`, `logbook:write` and
 * `logbook:sync`. It is responsible for querying, writing and deduplicating QSO
 * records internally. The host routes actions and passes narrow auto-upload
 * batches; it does not invent provider-specific synchronization behavior.
 *
 * Every method runs inside a fresh Host invocation. Results that complete after
 * unload/reload are discarded. Return structured `failures` for expected
 * operational problems; reserve thrown errors for unexpected failures. Provider
 * results, details and progress payloads must remain JSON-compatible.
 */
export interface LogbookSyncProvider {
  /** Stable service identifier (e.g. 'lotw', 'qrz', 'wavelog'). */
  readonly id: string;

  /** Display name (i18n key or literal text). */
  readonly displayName: string;

  /** Optional icon identifier (FontAwesome icon name or URL). */
  readonly icon?: string;

  /** Optional button color hint for the frontend (HeroUI color name). */
  readonly color?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';

  /** Which audience may access Host routes for this provider. Defaults to `admin`. */
  readonly accessScope?: 'admin' | 'operator';

  /**
   * ID of the settings page declared in `PluginDefinition.ui.pages`.
   * The host renders this page inside `<PluginIframeHost>` in the sync
   * settings modal, passing `{ callsign }` as params.
   */
  readonly settingsPageId: string;

  /**
   * Custom sync action menu items. When declared, these replace the default
   * three-item dropdown (download / upload / full_sync).
   *
   * Each action either performs an operation directly (`operation`) or opens
   * an iframe page for user input before proceeding (`pageId`).
   */
  readonly actions?: SyncAction[];

  /** Tests credentials/connectivity and returns a user-displayable result. */
  testConnection(callsign: string): Promise<SyncTestResult>;

  /**
   * Uploads QSO records to the external service.
   *
   * Manual uploads typically query the logbook via `ctx.logbook.queryQSOs()`
   * internally to determine which records to upload. Auto-upload may pass a
   * narrow `options.records` batch so providers can upload only the freshly
   * completed QSOs without re-scanning the entire logbook.
   *
   * Providers remain responsible for updating any per-QSO sync fields
   * (e.g. `lotwQslSent`) via `ctx.logbook.updateQSO()`.
   */
  upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult>;

  /**
   * Optional host-visible upload readiness check.
   *
   * When implemented, the host may call this before upload/full-sync actions
   * to surface blocked QSOs or missing configuration without starting upload.
   */
  getUploadPreflight?(callsign: string, options?: SyncUploadPreflightOptions): Promise<SyncUploadPreflightResult>;

  /**
   * Downloads QSO confirmations/records from the external service.
   *
   * The provider writes downloaded records or QSL updates directly into the
   * logbook via `ctx.logbook.addQSO()` / `ctx.logbook.updateQSO()`. It
   * should call `ctx.logbook.notifyUpdated()` when done.
   */
  download(callsign: string, options?: SyncDownloadOptions): Promise<SyncDownloadResult>;

  /** Returns `true` when the provider is fully configured for this callsign. */
  isConfigured(callsign: string): boolean;

  /** Returns `true` when auto-upload is enabled for this callsign. */
  isAutoUploadEnabled(callsign: string): boolean;
}

// ===== Sync action descriptor =====

/**
 * Describes a single sync action menu item displayed in the frontend dropdown.
 *
 * Either `operation` or `pageId` must be set (not both):
 * - `operation`: the host directly calls the corresponding provider method
 * - `pageId`: the host opens an iframe page where the user provides input;
 *   the page then triggers the operation via `bridge.invoke()`.
 */
export interface SyncAction {
  /** Unique action identifier within this provider. */
  id: string;
  /** Display label for the menu item. */
  label: string;
  /** Optional description text shown below the label. */
  description?: string;
  /** Icon hint: download / upload / sync. */
  icon?: 'download' | 'upload' | 'sync';
  /**
   * When set, clicking this action opens the iframe page (registered in
   * `PluginDefinition.ui.pages`) instead of directly executing an operation.
   * The page is responsible for collecting user input and calling
   * `bridge.invoke()` to trigger the actual sync.
   */
  pageId?: string;
  /**
   * When set (and `pageId` is not), clicking this action directly triggers
   * the corresponding provider method.
   */
  operation?: 'upload' | 'download' | 'full_sync';
}

// ===== Result types =====

/** Layer that produced a synchronization failure. */
export type SyncFailureSource = 'provider' | 'host' | 'remote' | 'network' | 'logbook';
/** User-visible synchronization operation associated with a failure. */
export type SyncFailureOperation = 'upload' | 'download' | 'full_sync' | 'preflight' | 'test_connection';

/**
 * Structured failure intended for logs and plugin UI.
 *
 * Construct failures with `createSyncFailure()` or `errorToSyncFailure()` so
 * common credentials are redacted. Direct object construction performs no
 * automatic sanitization.
 */
export interface SyncFailure {
  /** Stable machine-readable code owned by the provider or Host. */
  code: string;
  /** Short display message; callers constructing directly must sanitize secrets. */
  message: string;
  /** Layer that produced the failure. */
  source?: SyncFailureSource;
  /** Sync operation that was in progress. */
  operation?: SyncFailureOperation;
  /** Provider ID when the failure crosses a shared Host surface. */
  providerId?: string;
  /** Local QSO record ID for a per-record failure. */
  qsoId?: string;
  /** Remote station callsign for a per-record failure. */
  qsoCallsign?: string;
  /** HTTP response status when a remote request reached the server. */
  httpStatus?: number;
  /** Whether retrying later without changing input may succeed. */
  retryable?: boolean;
  /** Optional diagnostic detail; callers constructing directly must sanitize it. */
  detail?: string;
}

/** Input accepted by `createSyncFailure`, including values that must be redacted. */
export type SyncFailureInput = Omit<SyncFailure, 'message' | 'detail'> & {
  message?: string;
  detail?: string;
  secrets?: Array<string | undefined | null>;
};

const SECRET_QUERY_PARAM_PATTERN = /([?&](?:api[_-]?key|key|password|pass|token|auth|authorization|secret|login)=)([^&#\s]+)/gi;
const WAVELOG_STATION_INFO_KEY_PATTERN = /(\/station_info\/)([^/?#\s]+)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Best-effort redaction of explicit secrets and common credential-bearing URL/query patterns. */
export function sanitizeSyncFailureText(
  value: unknown,
  secrets: Array<string | undefined | null> = [],
): string {
  let text = typeof value === 'string' ? value : String(value ?? '');

  for (const secret of secrets) {
    if (!secret || secret.length < 4) {
      continue;
    }
    text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, 'g'), '[redacted]');
  }

  return text
    .replace(SECRET_QUERY_PARAM_PATTERN, '$1[redacted]')
    .replace(WAVELOG_STATION_INFO_KEY_PATTERN, '$1[redacted]');
}

/** Builds a normalized failure after sanitizing its message and detail. */
export function createSyncFailure(input: SyncFailureInput): SyncFailure {
  const secrets = input.secrets ?? [];
  const message = sanitizeSyncFailureText(input.message || input.code || 'Sync failed', secrets);
  const detail = input.detail ? sanitizeSyncFailureText(input.detail, secrets) : undefined;
  return {
    code: input.code,
    message,
    source: input.source,
    operation: input.operation,
    providerId: input.providerId,
    qsoId: input.qsoId,
    qsoCallsign: input.qsoCallsign,
    httpStatus: input.httpStatus,
    retryable: input.retryable,
    detail,
  };
}

/** Converts an unknown thrown value into a normalized, sanitized failure. */
export function errorToSyncFailure(
  error: unknown,
  defaults: SyncFailureInput,
): SyncFailure {
  const message = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : defaults.message);
  const errorCause = error instanceof Error
    ? (error as unknown as { cause?: unknown }).cause
    : undefined;
  const cause = errorCause instanceof Error ? errorCause.message : undefined;
  return createSyncFailure({
    ...defaults,
    message: message || defaults.message || defaults.code,
    detail: defaults.detail ?? cause,
  });
}

/** Formats one failure for compact user-facing lists. */
export function failureMessage(failure: SyncFailure): string {
  const prefix = failure.qsoCallsign ? `${failure.qsoCallsign}: ` : '';
  const suffix = failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : '';
  return `${prefix}${failure.message}${suffix}`;
}

/** Result returned by `LogbookSyncProvider.testConnection()`. */
export interface SyncTestResult {
  /** Whether credentials and the tested remote operation succeeded. */
  success: boolean;
  /** Human-readable result description. */
  message?: string;
  /** Additional service-specific details (e.g. account info, logbook count). */
  details?: unknown;
  /** Structured failures when the test did not fully succeed. */
  failures?: SyncFailure[];
}

/** Aggregate result returned after an upload attempt. */
export interface SyncUploadResult {
  /** Number of records submitted to the external service. */
  submitted?: number;
  /** @deprecated Upload providers should not verify by querying the external service; download sync owns confirmation. */
  verified?: number;
  /** Records accepted by the remote service and committed to local sync state. */
  uploaded: number;
  /** Records intentionally not submitted, for example because they were already sent. */
  skipped: number;
  /** Records that could not be uploaded. */
  failed: number;
  /** Structured per-record or operation failures. */
  failures?: SyncFailure[];
}

/** Incremental upload status sent to an optional in-process progress callback. */
export interface SyncUploadProgress {
  /** Current upload pipeline phase. */
  stage:
    | 'preparing'
    | 'prepared'
    | 'batch_uploading'
    | 'batch_accepted'
    | 'batch_failed'
    | 'updating_local'
    | 'finished';
  /** Station callsign whose logbook is being synchronized. */
  callsign?: string;
  /** One-based current batch number. */
  batchIndex?: number;
  /** Total number of upload batches. */
  batchCount?: number;
  /** QSO records represented by the current progress event. */
  qsoCount?: number;
  /** Records discovered as pending upload. */
  pendingCount?: number;
  /** Pending records eligible for this upload. */
  uploadableCount?: number;
  /** Pending records blocked by preflight validation. */
  blockedCount?: number;
  /** Records submitted to the remote service so far. */
  submitted?: number;
  /** Records accepted and reflected in local sync state so far. */
  uploaded?: number;
  /** @deprecated Upload providers should not verify by querying the external service; download sync owns confirmation. */
  verified?: number;
  /** Records intentionally skipped so far. */
  skipped?: number;
  /** Records whose upload failed so far. */
  failed?: number;
  /** Structured failures accumulated so far. */
  failureCount?: number;
  /** Optional short status text for custom UIs. */
  message?: string;
}

/** Optional range, source batch and progress callback for an upload. */
export interface SyncUploadOptions {
  /** Distinguishes manual uploads from auto-upload triggered by QSO completion. */
  trigger?: 'manual' | 'auto';
  /** Upload records starting at this timestamp (epoch ms), inclusive. */
  since?: number;
  /** Upload records ending at this timestamp (epoch ms), inclusive. */
  until?: number;
  /** Include records already marked as uploaded/sent locally. Defaults to false. */
  includeAlreadyUploaded?: boolean;
  /** Continue with uploadable records when preflight only found per-QSO blockers. */
  skipBlockedQsos?: boolean;
  /** Optional in-process progress callback for custom sync UIs. */
  onProgress?: (progress: SyncUploadProgress) => void;
  /**
   * Optional explicit QSO batch supplied by the host.
   *
   * When present, providers should prefer this list over performing another
   * logbook scan so auto-upload can stay scoped to the just-completed QSOs.
   */
  records?: import('@tx5dr/contracts').QSORecord[];
}

/** Range and inclusion rules used by an upload readiness check. */
export interface SyncUploadPreflightOptions {
  /** Check records starting at this timestamp (epoch ms), inclusive. */
  since?: number;
  /** Check records ending at this timestamp (epoch ms), inclusive. */
  until?: number;
  /** Include records already marked as uploaded/sent locally. Defaults to false. */
  includeAlreadyUploaded?: boolean;
}

/** One actionable issue discovered before upload starts. */
export interface SyncPreflightIssue {
  /** Stable provider-owned issue code. */
  code: string;
  /** Whether the issue is informational, cautionary or blocking. */
  severity: 'info' | 'warning' | 'error';
  /** Short user-facing explanation. */
  message: string;
  /** Optional sanitized diagnostic or remediation detail. */
  detail?: string;
  /** Local QSO ID when the issue concerns one record. */
  qsoId?: string;
  /** Target callsign when the issue concerns one record. */
  qsoCallsign?: string;
}

/** Aggregate readiness result shown before an upload or full sync. */
export interface SyncUploadPreflightResult {
  /** Whether upload can start without skipping blocking records. */
  ready: boolean;
  /** Records currently awaiting upload. */
  pendingCount: number;
  /** Pending records that can be uploaded now. */
  uploadableCount: number;
  /** Pending records blocked by validation or missing data. */
  blockedCount: number;
  /** Structured issues for the operation or individual records. */
  issues?: SyncPreflightIssue[];
  /** Whether the provider supports continuing with only uploadable records. */
  canSkipBlocked?: boolean;
  /** Optional ordered remediation hints for the UI. */
  guidance?: string[];
}

/** Aggregate result returned after downloading and reconciling remote data. */
export interface SyncDownloadResult {
  /** Number of records downloaded from the external service. */
  downloaded: number;
  /** Number of records matched to existing local QSOs. */
  matched: number;
  /** Number of local QSOs whose QSL status was updated. */
  updated: number;
  /** Number of downloaded records imported because no local match existed. */
  imported?: number;
  /** Number of provider request windows used to download the range. */
  windowCount?: number;
  /** Structured request, parsing or per-record failures. */
  failures?: SyncFailure[];
}

/** Incremental status sent while a provider downloads one or more windows. */
export interface SyncDownloadProgress {
  /** Current download pipeline phase. */
  stage:
    | 'preparing'
    | 'window_waiting'
    | 'window_downloading'
    | 'window_retrying'
    | 'window_processing'
    | 'window_done'
    | 'window_failed'
    | 'finished';
  /** Station callsign whose logbook is being synchronized. */
  callsign?: string;
  /** One-based current request-window number. */
  windowIndex?: number;
  /** Total request windows planned for the selected range. */
  windowCount?: number;
  /** Human-readable date/time range represented by the current window. */
  range?: string;
  /** Provider-mandated wait before the next request. */
  waitSeconds?: number;
  /** One-based retry attempt for the current window. */
  attempt?: number;
  /** Remote records returned by the current window. */
  recordCount?: number;
  /** Remote records downloaded so far. */
  downloaded?: number;
  /** Remote records matched to existing local QSOs so far. */
  matched?: number;
  /** Existing local QSOs updated so far. */
  updated?: number;
  /** New remote records imported so far. */
  imported?: number;
  /** Records/windows that failed so far. */
  failed?: number;
  /** Structured failures accumulated so far. */
  failureCount?: number;
  /** Optional short status text for custom UIs. */
  message?: string;
}

/** Optional date range and progress callback for a download. */
export interface SyncDownloadOptions {
  /** Download records since this timestamp (epoch ms). */
  since?: number;
  /** Download records until this timestamp (epoch ms). */
  until?: number;
  /** Optional in-process progress callback for custom sync UIs. */
  onProgress?: (progress: SyncDownloadProgress) => void;
}

// ===== Registrar interface =====

/**
 * Registration entry point exposed via `ctx.logbookSync`.
 */
export interface LogbookSyncRegistrar {
  /**
   * Registers a logbook sync provider. The host stores the reference and
   * exposes it through the sync settings UI and auto-upload pipeline.
   *
   * A single plugin may register multiple providers (e.g. one plugin
   * supporting both upload and download for different services).
   * The Host unregisters every provider owned by the plugin generation during
   * disable, reload or unload.
   */
  register(provider: LogbookSyncProvider): void;
}
