/**
 * Ambient type definitions for the TX-5DR Plugin Bridge SDK.
 *
 * The Bridge SDK is automatically injected into plugin iframe pages by the
 * host. It is available as `window.tx5dr` (or simply `tx5dr` in global
 * scope) — plugin code does **not** need to import or install anything at
 * runtime.
 *
 * ## Enabling IDE autocomplete
 *
 * **TypeScript** — add to `tsconfig.json`:
 * ```json
 * { "compilerOptions": { "types": ["@tx5dr/plugin-api/bridge"] } }
 * ```
 *
 * **JavaScript (VS Code)** — add to `jsconfig.json`:
 * ```json
 * { "compilerOptions": { "types": ["@tx5dr/plugin-api/bridge"] } }
 * ```
 *
 * Or add a triple-slash reference at the top of any `.js` / `.ts` file:
 * ```js
 * /// <reference types="@tx5dr/plugin-api/bridge" />
 * ```
 *
 * @see https://github.com/boybook/tx-5dr/blob/main/docs/plugin-system.md
 */

// ---------------------------------------------------------------------------
// Bridge SDK interface
// ---------------------------------------------------------------------------

/**
 * The TX-5DR Plugin Bridge SDK exposed as `window.tx5dr` inside plugin
 * iframe pages.
 *
 * All async methods communicate with the host via `postMessage` and return
 * Promises that resolve when the host responds.
 */
interface Tx5drBridge {
  // ── State (read-only) ────────────────────────────────────────────────

  /** URL query parameters passed to this iframe page (read-only). */
  readonly params: Readonly<Record<string, string>>;

  /** Current theme: `'dark'` or `'light'`. */
  readonly theme: 'dark' | 'light';

  /** Current locale code (e.g. `'zh'`, `'en'`). */
  readonly locale: string;

  /** Unique session ID assigned to this iframe instance by the host. */
  readonly pageSessionId: string;

  // ── RPC ──────────────────────────────────────────────────────────────

  /**
   * Send a request to the plugin's server-side page handler
   * (`ctx.ui.registerPageHandler`).
   *
   * @param action  An application-defined action name.
   * @param data    Optional payload forwarded to the handler.
   * @returns       The value returned by the handler's `onMessage` method.
   */
  invoke(action: string, data?: unknown): Promise<unknown>;

  // ── Push messaging ───────────────────────────────────────────────────

  /**
   * Subscribe to server-initiated push messages.
   *
   * The server sends pushes via `ctx.ui.pushToPage(pageId, action, data)`
   * or `requestContext.page.push(action, data)`.
   */
  onPush(action: string, callback: (data: any) => void): void;

  /** Unsubscribe a previously registered push listener. */
  offPush(action: string, callback: (data: any) => void): void;

  // ── Key-value store ──────────────────────────────────────────────────

  /**
   * Read a value from the page-scoped persistent KV store.
   *
   * Scope is determined by the page's instance target and resource binding
   * (e.g. per-callsign).
   */
  storeGet<T = unknown>(key: string, defaultValue?: T): Promise<T>;

  /** Write a value to the page-scoped persistent KV store. */
  storeSet(key: string, value: unknown): Promise<void>;

  /** Delete a key from the page-scoped persistent KV store. */
  storeDelete(key: string): Promise<void>;

  // ── File storage ─────────────────────────────────────────────────────

  /**
   * Upload a file to the page-scoped file storage.
   *
   * Files are stored under a sandboxed directory determined by the page's
   * instance target and resource binding.
   */
  fileUpload(path: string, file: File | Blob): Promise<void>;

  /** Read a file from page-scoped storage. Returns `null` if not found. */
  fileRead(path: string): Promise<Blob | null>;

  /** Delete a file from page-scoped storage. */
  fileDelete(path: string): Promise<boolean>;

  /** List file paths under the given prefix in page-scoped storage. */
  fileList(prefix?: string): Promise<string[]>;

  // ── UI controls ──────────────────────────────────────────────────────

  /**
   * Report the iframe content height so the host can resize the iframe.
   *
   * Recommended: use a `ResizeObserver` on `document.body` and call
   * `tx5dr.resize(document.body.scrollHeight)` on every change.
   */
  resize(height: number): void;

  /** Ask the parent component to close this iframe (e.g. close a modal). */
  requestClose(): void;

  /** Register a callback invoked when the host theme changes. */
  onThemeChange(callback: (theme: 'dark' | 'light') => void): void;
}

// ---------------------------------------------------------------------------
// Global augmentation
// ---------------------------------------------------------------------------

interface Window {
  /** TX-5DR Plugin Bridge SDK — injected by the host into iframe pages. */
  readonly tx5dr: Tx5drBridge;
}

/**
 * Shorthand global reference to the Bridge SDK.
 *
 * Equivalent to `window.tx5dr`. Available because the SDK is injected as a
 * global before any plugin script runs.
 */
declare var tx5dr: Tx5drBridge;
