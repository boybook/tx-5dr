# Device Panel Boundary

**Status:** accepted; server API implemented, external panel remains a separate project.

## Context

A small hardware display needs a stable, low-bandwidth view of TX-5DR state.
Putting a device daemon, renderer, Python runtime, GPIO/display drivers, and
hardware packaging inside the Node.js monorepo would couple unrelated release
lifecycles and make server builds depend on panel hardware.

## Decision

TX-5DR owns authentication and a read-only projection API. A panel application
owns rendering, input devices, display drivers, local service management, and
hardware packaging in a separate repository.

The main repository exposes:

- `GET /api/device-ui/health`: unauthenticated service health;
- `POST /api/device-ui/session`: exchange the device session token for a
  short-lived device JWT;
- `GET /api/device-ui/bootstrap`: authenticated current snapshot;
- `GET /api/device-ui/ws`: authenticated, server-push snapshot stream.

The dedicated WebSocket does not join the browser handshake, operator filters,
or browser client count. The MVP ignores client messages and only pushes
validated `DeviceUiBootstrapSnapshot` values.

## Authentication

- The server generates a device session token in its config directory with
  mode `0600`.
- The panel exchanges that token for an HS256 JWT with type `device-ui` and
  audience `tx5dr-device-ui`.
- The default JWT lifetime is 12 hours. Sessions are persisted, expire, and can
  be revoked.
- The panel does not receive an administrator token or unrestricted browser JWT.

## Projection

The snapshot contains only data needed for a station display:

- server version and local Web URLs;
- station callsigns and operator activity;
- engine/radio/mode/frequency/PTT state;
- FT8 slot, recent frames, and current transmission;
- voice keyer/PTT lock state;
- CW decoder/keyer state.

Secrets, radio connection credentials, arbitrary config, log contents, plugin
storage, and filesystem paths are not part of the projection.

## Client Boundary

The external panel may use Python or another runtime. It is responsible for:

- display and input hardware;
- UI layout and local caching;
- reconnect/backoff and stale-state presentation;
- systemd or other host service packaging;
- mock mode for development without physical hardware.

The initial client does not mutate Wi-Fi, create hotspots, install root helpers,
or control TX-5DR through browser/admin endpoints. Any future write command
requires a separate capability, authorization, validation, and audit decision.

## Source Anchors

- Contracts: `packages/contracts/src/schema/device-ui.schema.ts`
- REST authentication and bootstrap: `packages/server/src/device-ui/routes.ts`
- WebSocket: `packages/server/src/device-ui/DeviceUiWSServer.ts`
- Projection: `packages/server/src/device-ui/DeviceUiProjectionService.ts`
- Session auth: `packages/server/src/auth/DeviceServiceAuthManager.ts`
- Guard tests: `packages/server/src/device-ui/__tests__/`
