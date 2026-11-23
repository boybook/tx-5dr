/**
 * Desktop bridge capability policy.
 *
 * Pages reach the shell only through the preload bridge and IPC. A page is
 * trusted according to where it was loaded from, not according to what the
 * preload decided to expose: the main process classifies every IPC sender and
 * checks the channel against this table before running a handler.
 *
 * - `shell`: local pages shipped with the desktop app (loading/station pages).
 * - `embedded`: the station UI served by this app's own embedded server.
 * - `remote`: the station UI served by a station the user chose to connect to.
 *   Its pages and plugins only get capabilities that are safe to grant to that
 *   station; local files, desktop updates and local network settings stay out.
 */

import { DESKTOP_BRIDGE_VERSION, type DesktopBridgeCapability } from '@tx5dr/contracts';

export { DESKTOP_BRIDGE_VERSION };
export type { DesktopBridgeCapability };

export type BridgeSenderKind = 'shell' | 'embedded' | 'remote';

const CAPABILITIES_BY_KIND: Record<BridgeSenderKind, readonly DesktopBridgeCapability[]> = {
  shell: ['appInfo', 'startupLogs', 'stations', 'stationManagement'],
  embedded: [
    'windows',
    'externalLinks',
    'saveFile',
    'selectPath',
    'openAppDirectory',
    'appInfo',
    'appLifecycle',
    'closeBehavior',
    'shortcuts',
    'shortcutSettings',
    'desktopUpdates',
    'desktopHttps',
    'desktopRemoteAccess',
    'stations',
  ],
  remote: [
    'windows',
    'externalLinks',
    'saveFile',
    'appInfo',
    'closeBehavior',
    'shortcuts',
    'stations',
  ],
};

/** Capabilities a standalone plugin page window never receives, even for its own station. */
const PLUGIN_PAGE_DENIED: ReadonlySet<DesktopBridgeCapability> = new Set([
  'appLifecycle',
  'openAppDirectory',
  'shortcutSettings',
  'desktopUpdates',
  'desktopHttps',
  'desktopRemoteAccess',
  'stations',
  'stationManagement',
]);

const CHANNEL_CAPABILITY: Readonly<Record<string, DesktopBridgeCapability>> = {
  'window:openAbout': 'windows',
  'window:openLogbook': 'windows',
  'window:openPluginPage': 'windows',
  'window:openSpectrumWindow': 'windows',
  'shell:openExternal': 'externalLinks',
  'shell:openPath': 'openAppDirectory',
  'fs:saveFile': 'saveFile',
  'fs:selectFile': 'selectPath',
  'fs:selectDirectory': 'selectPath',
  'app:getVersion': 'appInfo',
  'app:getBuildInfo': 'appInfo',
  'app:quit': 'appLifecycle',
  'app:restart': 'appLifecycle',
  'config:get': 'closeBehavior',
  'config:set': 'closeBehavior',
  'config:getAll': 'closeBehavior',
  'shortcuts:getConfig': 'shortcuts',
  'shortcuts:getToggles': 'shortcuts',
  // Global shortcuts act on every application and persist in the shell, so a
  // remote station can use them but not change them.
  'shortcuts:setToggles': 'shortcutSettings',
  'shortcuts:setConfig': 'shortcutSettings',
  'shortcuts:register': 'shortcutSettings',
  'shortcuts:startRecording': 'shortcutSettings',
  'shortcuts:stopRecording': 'shortcutSettings',
  'voicePttShortcut:setConfig': 'shortcuts',
  'updater:getStatus': 'desktopUpdates',
  'updater:setChannel': 'desktopUpdates',
  'updater:check': 'desktopUpdates',
  'updater:openDownload': 'desktopUpdates',
  'updater:download': 'desktopUpdates',
  'updater:installAndRestart': 'desktopUpdates',
  'https:getStatus': 'desktopHttps',
  'https:getShareUrls': 'desktopHttps',
  'https:generateSelfSigned': 'desktopHttps',
  'https:importPemCertificate': 'desktopHttps',
  'https:applySettings': 'desktopHttps',
  'https:disable': 'desktopHttps',
  'remoteAccess:getPreset': 'desktopRemoteAccess',
  'remoteAccess:applyPreset': 'desktopRemoteAccess',
  'startupLogs:subscribe': 'startupLogs',
  'startupLogs:unsubscribe': 'startupLogs',
  'startupLogs:openFolder': 'startupLogs',
  'startupLogs:runAction': 'startupLogs',
  'stations:openManager': 'stations',
  'stations:getCurrent': 'stations',
  'stations:getState': 'stationManagement',
  'stations:subscribe': 'stationManagement',
  'stations:unsubscribe': 'stationManagement',
  'stations:probe': 'stationManagement',
  'stations:save': 'stationManagement',
  'stations:remove': 'stationManagement',
  'stations:connect': 'stationManagement',
  'stations:trustCertificate': 'stationManagement',
};

export function getChannelCapability(channel: string): DesktopBridgeCapability | null {
  return CHANNEL_CAPABILITY[channel] ?? null;
}

export function listBridgeChannels(): string[] {
  return Object.keys(CHANNEL_CAPABILITY);
}

export function getCapabilitiesForKind(kind: BridgeSenderKind): DesktopBridgeCapability[] {
  return [...CAPABILITIES_BY_KIND[kind]];
}

/** A station whose session owns a sender, with the origin its pages are served from. */
export interface BridgeStationBinding {
  kind: 'embedded' | 'remote';
  origin: string;
}

export interface BridgeSenderInput {
  /** True only when the IPC came from the top-level frame of its web contents. */
  isMainFrame: boolean;
  frameUrl: string;
  /** Station bound to the sender's session, if any. */
  station: BridgeStationBinding | null;
  /** URLs of the shell's own pages (local files, or dev server pages in development), without query or hash. */
  shellPageUrls: readonly string[];
}

export interface BridgeSender {
  kind: BridgeSenderKind;
  isPluginPage: boolean;
}

/**
 * A page address without query or hash and with its path decoded. Chromium and
 * `pathToFileURL` escape characters such as `[`, `]`, `~` and `%` differently
 * in file URLs, so both sides are compared in this form. The preload carries an
 * identical copy (checked by a test).
 */
export function canonicalPageUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // Decode each run of escapes on its own, so a literal `%` elsewhere in the path stays as it is.
  const pathname = url.pathname.replace(/(?:%[0-9a-fA-F]{2})+/g, (escaped) => {
    try {
      return decodeURIComponent(escaped);
    } catch {
      return escaped;
    }
  });
  return `${url.protocol}//${url.host}${pathname}`;
}

function isShellPageUrl(href: string, shellPageUrls: readonly string[]): boolean {
  const page = canonicalPageUrl(href);
  return page !== null && shellPageUrls.some(candidate => canonicalPageUrl(candidate) === page);
}

/** Classifies an IPC sender, or returns null when it must not reach the bridge at all. */
export function classifyBridgeSender(input: BridgeSenderInput): BridgeSender | null {
  // Same-origin plugin iframes call through `parent.electronAPI` and arrive as the
  // main frame, so this rejects only frames that are not same-origin (see the
  // known gap in docs/decisions/desktop-remote-station.md).
  if (!input.isMainFrame) return null;
  let url: URL;
  try {
    url = new URL(input.frameUrl);
  } catch {
    return null;
  }

  if (isShellPageUrl(url.href, input.shellPageUrls)) return { kind: 'shell', isPluginPage: false };
  if (url.protocol === 'file:') return null;

  if (!input.station || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  let stationOrigin: string;
  try {
    stationOrigin = new URL(input.station.origin).origin;
  } catch {
    return null;
  }
  if (url.origin !== stationOrigin) return null;
  return {
    kind: input.station.kind,
    isPluginPage: url.pathname.endsWith('/plugin-page.html'),
  };
}

export function isCapabilityAllowed(sender: BridgeSender, capability: DesktopBridgeCapability): boolean {
  if (!CAPABILITIES_BY_KIND[sender.kind].includes(capability)) return false;
  return !(sender.isPluginPage && PLUGIN_PAGE_DENIED.has(capability));
}

export type BridgeDecision =
  | { allowed: true; sender: BridgeSender; capability: DesktopBridgeCapability }
  | { allowed: false; reason: 'unknown_channel' | 'untrusted_sender' | 'capability_denied' };

export function evaluateBridgeCall(channel: string, input: BridgeSenderInput): BridgeDecision {
  const capability = getChannelCapability(channel);
  if (!capability) return { allowed: false, reason: 'unknown_channel' };
  const sender = classifyBridgeSender(input);
  if (!sender) return { allowed: false, reason: 'untrusted_sender' };
  if (!isCapabilityAllowed(sender, capability)) return { allowed: false, reason: 'capability_denied' };
  return { allowed: true, sender, capability };
}

/** Electron settings keys a station page may read or write through `config:*`. */
const CONFIG_VALUE_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  closeBehavior: value => value === 'ask' || value === 'tray' || value === 'quit',
};

export function isBridgeConfigKey(key: unknown): key is string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(CONFIG_VALUE_VALIDATORS, key);
}

export function isValidBridgeConfigValue(key: string, value: unknown): boolean {
  return isBridgeConfigKey(key) && CONFIG_VALUE_VALIDATORS[key](value);
}

export function listBridgeConfigKeys(): string[] {
  return Object.keys(CONFIG_VALUE_VALIDATORS);
}

/** Command-line switches carrying a window's bridge grant to the preload. */
export const BRIDGE_KIND_SWITCH = '--tx5dr-station-kind=';
export const BRIDGE_VERSION_SWITCH = '--tx5dr-bridge-version=';
export const BRIDGE_CAPABILITIES_SWITCH = '--tx5dr-bridge-capabilities=';
export const BRIDGE_SHELL_PAGES_SWITCH = '--tx5dr-shell-pages=';

/** Lets the preload recognize the shell's own pages; the main process re-checks every call. */
export function buildShellPagesArgument(shellPageUrls: readonly string[]): string {
  return `${BRIDGE_SHELL_PAGES_SWITCH}${shellPageUrls.map(encodeURIComponent).join(',')}`;
}

/**
 * Preload arguments of a station window. A standalone plugin page window is
 * granted what `isCapabilityAllowed` lets a plugin page use, so it does not
 * offer entries the main process would refuse.
 */
export function buildBridgeArguments(
  kind: 'embedded' | 'remote',
  shellPageUrls: readonly string[] = [],
  options: { pluginPage?: boolean } = {},
): string[] {
  const capabilities = CAPABILITIES_BY_KIND[kind].filter(capability => !(options.pluginPage && PLUGIN_PAGE_DENIED.has(capability)));
  return [
    `${BRIDGE_KIND_SWITCH}${kind}`,
    `${BRIDGE_VERSION_SWITCH}${DESKTOP_BRIDGE_VERSION}`,
    `${BRIDGE_CAPABILITIES_SWITCH}${capabilities.join(',')}`,
    buildShellPagesArgument(shellPageUrls),
  ];
}
