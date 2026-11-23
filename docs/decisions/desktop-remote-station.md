# Desktop shell, stations and the bridge contract

## Decision

The desktop application is a shell that shows a station's own Web UI. A station
(the embedded server, or a remote TX-5DR the user connects to) always serves the
UI built from the same source as its server, so the UI-to-server protocol is never
negotiated across builds. Only two contracts cross builds:

- `GET /api/station/identity` (`StationIdentitySchema` in `@tx5dr/contracts`):
  public, unauthenticated build identity. It carries no paths, network addresses,
  callsigns or credentials. A station without it is refused, not guessed at.
- The desktop bridge (`window.electronAPI`): shell capabilities offered to the
  page. `DESKTOP_BRIDGE_VERSION` and `DesktopBridgeCapabilitySchema` define it;
  pages read the grant from `electronAPI.bridge` and feature-detect each member.

Compatibility rules: a new shell capability is added to the capability list;
`DESKTOP_BRIDGE_VERSION` changes only when an older shell cannot satisfy a page.
A station advertises the lowest bridge version its UI requires
(`desktopBridge.minVersion`).

## Trust and capability policy

The trust boundary is the station the user chose. Its pages and plugins (plugin
iframes are same-origin with the station page) receive only capabilities that are
safe to grant to that station. `packages/electron-main/src/bridgePolicy.ts` owns
the channel-to-capability table and classifies every IPC sender from its frame,
origin and session before a handler runs; the preload exposure is a convenience,
not the enforcement point.

| Sender | Capabilities |
| --- | --- |
| Shell page (`file:` pages shipped with the app) | app info, startup logs, open and manage stations |
| Embedded station | windows, external links, save/select files, open app directories, app info and lifecycle, close behavior, shortcuts, desktop updates, desktop HTTPS, desktop remote access, open station manager |
| Remote station | windows, external links, save file, app info, close behavior, shortcuts, open station manager |

Every station page may open the station manager and read which desktop station
it belongs to (`stations.getCurrent`: kind, and for a remote station the name
and address the user saved). Managing, probing, trusting and opening stations
(`stationManagement`) is available only to the shell's own pages: `loading.html`
and the station manager, `station-manager.html` from the shell's own packaged Web
build (the Vite dev server page in development), never a page served by a
station. Shell pages are recognized by their exact URL, passed to the preload by
the main process and re-checked for every call. The station list and connection
state crossing to that page are decoded with `DesktopStationsStateSchema` and the
related schemas in `@tx5dr/contracts`.

Standalone plugin page windows never receive app lifecycle, app directories,
desktop updates, desktop HTTPS or desktop remote access, even for their own
station. Subframes and unknown origins or sessions are rejected.

`shell:openPath` opens only paths that resolve, after following symbolic links,
inside the app's config, data, logs or cache roots
(`appDirectoryPolicy.ts`). Station pages may read or write only whitelisted
shell settings through `config:*`, each with a value validator.

Embedded station windows keep their existing web preferences; tightening them is
separate from this contract.

## Stations and windows

`packages/electron-main/src/stationProfiles.ts` owns the persisted station list:
the embedded station always exists and is not stored; each remote profile keeps
its normalized origin, a fixed loopback gateway port, an optional pinned
certificate and the last identity seen. The last opened or focused station is
opened first on the next launch.

Each station has at most one station window, and stations can be open side by
side. Opening a station focuses its window or creates one; it never closes another
station. A remote station renders in its own persistent partition
(`persist:station-<id>`) with web security and the sandbox on. Renderer-initiated
navigation stays on the gateway origin, other web links open in the system browser,
and only the permissions the station UI needs (audio capture, notifications,
clipboard, fullscreen) are granted to that origin. A remote gateway runs while any
window of that station is open and stops when its last window closes.

Closing a station window while another station window stays open only closes
that window; the embedded server keeps running as in background mode. Closing the
last station window applies the configured close behavior.

Keyboard capture for voice PTT is held per window, so a PTT key acts only on the
window that has focus. System-wide shortcuts act on the station window that was
focused last; with several stations open, that is the one the operator used most
recently.

Before loading a remote station the shell probes `/api/station/identity`
(`stationProbe.ts`). A missing or invalid identity, an unsupported bridge version,
an unreachable station or a redirect is shown on the station's connect page
instead of loading anything. HTTPS stations use system trust; otherwise the user
confirms the presented SHA-256 fingerprint, which is then pinned. A changed pinned
certificate blocks the connection until the user explicitly trusts the newly
presented fingerprint; only a fingerprint the station just presented can be trusted.

## Local network discovery

Stations announce themselves as DNS-SD `_tx5dr._tcp` (see
[server startup](../architecture/server-startup.md)). The desktop client browses
only while the station manager is open (`stationDiscovery.ts`). An announcement
is listed only after the station at the announced address answered
`/api/station/identity` with the announced instance ID; the embedded station's own
announcement is ignored. Its display name comes from the station's public profile,
because announcements carry no callsign or host name.

macOS requires Local Network permission for multicast DNS. The packaged app
declares `NSLocalNetworkUsageDescription` and `NSBonjourServices`
(`_tx5dr._tcp`); without them, both browsing and the embedded server's
announcement are silently blocked. A development Electron binary has its own
permission entry under System Settings > Privacy & Security > Local Network.
