/**
 * Logbook sync provider interfaces.
 *
 * A utility plugin registers a sync provider via `ctx.logbookSync.register()`
 * during `onLoad`. The host manages per-callsign lifecycle, auto-upload on QSO
 * completion, and renders the provider's settings page in the sync modal.
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
 * The provider has full access to the logbook via `ctx.logbook` and is
 * responsible for querying, writing and deduplicating QSO records internally.
 * The host only routes user actions to provider methods — it does not read or
 * write QSOs on the provider's behalf.
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

  /** Tests whether the external service connection is healthy. */
  testConnection(callsign: string): Promise<SyncTestResult>;

  /**
   * Uploads QSO records to the external service.
   *
   * The provider queries the logbook via `ctx.logbook.queryQSOs()` internally
   * to determine which records to upload. It is also responsible for updating
   * QSL status fields (e.g. `lotwQslSent`) via `ctx.logbook.updateQSO()`.
   */
  upload(callsign: string): Promise<SyncUploadResult>;

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

export interface SyncTestResult {
  success: boolean;
  /** Human-readable result description. */
  message?: string;
  /** Additional service-specific details (e.g. account info, logbook count). */
  details?: unknown;
}

export interface SyncUploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
  errors?: string[];
}

export interface SyncDownloadResult {
  /** Number of records downloaded from the external service. */
  downloaded: number;
  /** Number of records matched to existing local QSOs. */
  matched: number;
  /** Number of local QSOs whose QSL status was updated. */
  updated: number;
  errors?: string[];
}

export interface SyncDownloadOptions {
  /** Download records since this timestamp (epoch ms). */
  since?: number;
  /** Download records until this timestamp (epoch ms). */
  until?: number;
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
   */
  register(provider: LogbookSyncProvider): void;
}
