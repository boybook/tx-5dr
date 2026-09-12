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
