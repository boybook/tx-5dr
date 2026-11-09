---
name: tx5dr-development
description: Implement or review TX-5DR application changes, radio/audio behavior, and development-time station validation or bug reproduction. Use across Web, server, Electron, persistence and plugins; public SDK changes and publication have specialized skills.
---

# TX-5DR Development

Start with `AGENTS.md` and the current implementation. Identify the behavior the
user wants, its state owner, and the smallest change that preserves that boundary.
Use this skill for ordinary application work as well as radio changes; hardware
rules apply only when the task reaches the hardware boundary.

## Find the owner

Read only the relevant contract and nearby implementation/tests:

| Change | Owner and reference |
| --- | --- |
| Browser state, controls, rendering, reconnect | Web store/providers; [frontend rendering](../../../docs/architecture/frontend-rendering.md) and [client notifications](../../../docs/decisions/client-notifications.md) |
| Settings dialog tabs, sections, cards, type scale | Shared layout primitives; [settings UI](references/settings-ui.md) |
| API, WebSocket, IPC, shared values | Runtime schemas in `packages/contracts`, core transport, server routes, Electron main/preload; validate inputs and permissions at the receiver |
| Server startup, resource lifetime, mode changes | [Server lifecycle](../../../docs/architecture/server-startup.md) |
| Settings, logbook, plugin data, recovery | [Persistence durability](../../../docs/architecture/persistence-durability.md); successful writes must survive restart |
| Electron child processes and readiness | [Desktop startup](../../../docs/architecture/desktop-startup.md) |
| Updating an installed application | [Update ownership](../../../docs/architecture/release-updates.md); installed identity and selected channel are distinct |
| Built-in plugin behavior and QSO automation | Plugin runtime owns policy; Host owns guarded execution; [plugin guide](../../../docs/plugin-system.md) and [assisted queue](../../../docs/architecture/assisted-qso-queue.md) |
| Radio protocol, PTT, audio, spectrum | [Radio boundaries and guard tests](references/radio-boundaries-and-tests.md), then only the relevant architecture document |

Use [tx5dr-plugin-api-change](../tx5dr-plugin-api-change/SKILL.md) when changing
public SDK exports, Host capabilities, scaffold or marketplace contracts. An
isolated built-in plugin fix need not become a public API change. Use
[tx5dr-release](../tx5dr-release/SKILL.md) for packaging, publication and update
distribution; a local build is not a release.

For development-time station validation, audio peers or a radio/audio bug
reproduction, including an Agent loading plugins and operating their UI, read
[station validation](references/station-validation.md).
Real-slot and native/codec integration are explicit development checks only:
never add them to unit tests, aggregate test scripts or default CI. Keep the
production pipeline shared and inject faults only at external boundaries.

## Implement and review

1. Trace one user action from UI/transport to the authoritative owner and back
   to its status projection. Decide where validation, failure and cleanup belong
   before editing multiple packages.
2. Preserve the established UI layout and interaction patterns. Keep permission,
   loading, empty, failed and disconnected states meaningful at the affected
   control. Check narrow layouts and `zh`/`en`/`ja` when presentation changes.
3. Keep one writer for each state. Browser views and embedded hosts project the
   owner; they do not create a second configuration store or scheduler. Fence
   asynchronous results by the existing request/session/generation lifetime.
4. For disk or wire-format changes, inspect actual old producers and consumers.
   Support the known historical format explicitly, with a bounded decoder and
   fixtures; do not invent a generic migration framework or silently reset data.
5. Cover the observable failure that motivated a fix. For stateful work include
   cancellation, restart, permissions or concurrent writers where they actually
   apply. Avoid implementation-mirroring tests for simple wording/layout edits.
6. Update the owning architecture contract when ownership or lifecycle changes.
   Keep current implementation explanations in `docs`; put one-off test results,
   plans and screenshots in ignored output or the issue/PR, not maintained docs.

Protocol parsing and protocol-level retry belong in the public protocol library
when one exists. TX-5DR owns Profile policy, lifecycle, permission and projection.
Do not bypass a disabled capability just because its adapter method still exists.
Never key a real radio, change physical power or perform on-air testing without
authorization for that hardware action.

## Validate and report

Run the closest affected tests first, then the checks listed in `AGENTS.md`
according to blast radius. Use the Node version from the relevant CI workflow
and the pinned Yarn version; distinguish environment failures from regressions.
For a documentation-only change, check references and skill metadata without
building native products unnecessarily.

Report the changed behavior, evidence and remaining limits. Unit/virtual tests,
native loading, packaged startup and real hardware each prove different things.
Source edits do not imply permission to publish, deploy or operate hardware.
