# Desktop startup readiness

Electron owns the browser gateway and its startup readiness checks. In development,
`scripts/dev-runtime.js` starts the backend and Vite; Electron waits for the backend
ready file and frontend availability before launching its gateway on a separate
port. Packaged Electron owns both child processes. Backend identity and negotiated
ports remain governed by `backendPortNegotiation.ts` and the ready files.

`httpReadiness.ts` owns the lifetime of each frontend/gateway HTTP availability
check. It permits one in-flight request per check, bounds each attempt by the
remaining overall deadline, and releases the request, response and timers on
settlement. Socket timeout/error events cannot create independent retry chains.
Success and deadline expiry are terminal; no queued work may continue probing.

Availability uses response headers and retains the existing acceptance of HTTP
200–499, including authentication responses. A response body need not finish for
the check to release its connection. Local HTTPS gateway checks retain support
for the configured self-signed certificate. These checks do not replace backend
identity verification or change browser authentication and origin policies.

`packages/electron-main/src/__tests__/httpReadiness.test.ts` guards retry counts,
deadlines, late socket events, HTTPS options and cleanup with real local sockets.

## Station startup order

The embedded station's startup (`createWindow`) can run with or without owning a
window. When the last used station is remote, its window and gateway start first
and the embedded station starts in the background; embedded startup failures (VC
runtime, native modules, ports) are then recorded for the station manager instead
of taking over a window or raising dialogs, so a remote station stays usable on a
machine whose embedded server cannot start. Embedded startup error cards always
offer the station manager.

## Remote station gateway

A remote station is shown through `packages/client-tools/src/remote-gateway.js`,
a separate loopback gateway from the embedded `proxy.js`. It forwards every page,
API and WebSocket request to the station's own Web entrypoint, so the page is
served by the station build it talks to while its origin stays
`http://127.0.0.1:<port>` (a secure context). The port is fixed per station
profile because the page's browser storage, including its sign-in, is bound to
that origin; a bind conflict fails startup instead of moving to another port.

The gateway accepts only a loopback `Host` for its own port and, when present,
its own `Origin`; WebSocket upgrades must carry that origin. It does not forward
`Origin`, `Referer` or forwarding headers: the station sees an ordinary client
that still needs normal authentication, and station origin policy is unchanged.
Redirects within the station are rewritten to gateway paths; redirects to another
origin are refused. Either side ending a WebSocket tears down both sockets.

HTTPS stations are verified with system trust, or against a pinned SHA-256
certificate fingerprint before any request byte is sent. A mismatch fails the
request (`UPSTREAM_CERT_MISMATCH`) rather than falling back to an unverified
connection. `packages/client-tools/src/__tests__/remote-gateway.test.js` covers
these rules with real local sockets and certificates.
