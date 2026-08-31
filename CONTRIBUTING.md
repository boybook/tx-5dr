# Contributing to TX-5DR

TX-5DR combines Web, server, desktop, native modules, and radio hardware. Keep
changes within the component that owns the behavior and state the evidence used
for hardware or platform claims.

## Prerequisites

- Node.js 22 for the main application and release-compatible local builds
- Corepack with the repository-pinned Yarn 4 version
- Platform toolchains required by any native dependency being rebuilt

```bash
corepack enable
yarn install --immutable
```

Do not use npm to install the monorepo or create `package-lock.json`.

## Engineering Principles

Start feature and bug-fix work by identifying the component that should own the
behavior and the invariant it must preserve. A quick patch in a caller, UI, or
event projection is not a good fix when the underlying owner has the wrong
contract or lifecycle.

An elegant TX-5DR design is simple, cohesive, and unsurprising. It has one clear
owner, explicit state and failure semantics, narrow stable interfaces, and few
special cases. Elegance does not mean adding more layers: avoid clever
indirection, hidden coupling, speculative generalization, and frameworks built
for hypothetical future requirements.

Prefer the smallest coherent architectural change:

- correct the owning abstraction instead of accumulating symptom-specific
  branches;
- avoid broad refactors that are not required to deliver and validate the
  requested behavior;
- introduce a new abstraction only when the existing one cannot express the
  requirement without duplication, hidden coupling, or unsafe state;
- make compatibility shims and temporary fallbacks explicit and removable;
- preserve security, persistence, protocol, and RF behavior outside the stated
  scope.

If a change moves responsibility between modules, alters resource or connection
lifecycle, changes a cross-process schema, or materially changes event/data
flow, update the corresponding document under `docs` in the same change. Do not
rewrite architecture documents for ordinary local implementation details.

## Development

```bash
# Server + Web
yarn dev

# Server + Web + Electron host
yarn dev:electron

# Detailed server logging
LOG_LEVEL=debug yarn dev
```

Workspaces can be run separately for focused debugging:

```bash
yarn workspace @tx5dr/server dev
yarn workspace @tx5dr/web dev
yarn workspace @tx5dr/electron-main dev
```

## Validation

Use the narrowest useful test while iterating. Before handing off a cross-package
change, broaden validation according to its blast radius.

```bash
yarn lint
yarn test
yarn build
yarn check:i18n
```

Focused server and public API checks include:

```bash
yarn workspace @tx5dr/server test:unit
yarn workspace @tx5dr/server test:virtual-radio-integration
yarn workspace @tx5dr/server test:logbook-performance
yarn workspace @tx5dr/plugin-api test
yarn workspace @tx5dr/plugin-api smoke:pack
```

Native-module loading can be checked on the current platform with:

```bash
yarn workspace @tx5dr/server dev:check-native
```

This is not proof that another operating system, CPU architecture, packaged
runtime, or physical radio works. Record those results separately.

## Cross-Package Changes

- Add or change runtime schemas in `packages/contracts` before their producers
  and consumers.
- Keep runtime-neutral clients and parsers in `packages/core`.
- Keep radio, audio, persistence, permission, and plugin Host ownership in
  `packages/server`.
- Keep browser rendering and interaction in `packages/web`.
- Keep public plugin imports inside `packages/plugin-api`; verify the packed
  consumer when its exports change.

Frontend text must use i18n and keep `zh`, `en`, and `ja` resources aligned.
Application logs use package `createLogger` helpers, English messages, and no
emoji.

## Host and Plugin Responsibilities

Plugins own feature-specific policy, configuration, scoring, exchange rules,
external-service behavior, and custom presentation. The Host owns reusable
mechanisms such as lifecycle, authorization, isolated storage, event delivery,
stable state projections, arbitration, and guarded radio/logbook/network ports.

Do not implement a plugin requirement through a hidden agreement with the Host.
Forbidden patterns include:

- Host branches keyed by a plugin name or built-in plugin identity;
- private event names, storage keys, settings fields, or payload conventions
  understood only by one Host branch and one plugin;
- undocumented context properties or privileged calls that bypass declared
  permissions;
- direct access from a built-in plugin to Host internals that external plugins
  cannot use through the public API.

When a plugin exposes a missing platform capability, first separate its policy
from the underlying mechanism. Keep the policy in the plugin. Add the smallest
generic Host mechanism only when it has neutral semantics, explicit permission
and validation, a typed public contract, lifecycle ownership, and tests that do
not depend on the originating plugin. A single current consumer does not justify
a hidden shortcut, but it also does not justify a speculative framework.

## Documentation

Maintained engineering documentation is indexed in [`docs/README.md`](docs/README.md).
Operator installation and usage documentation belongs in the separate
[`tx-5dr-site`](https://github.com/boybook/tx-5dr-site) repository.

Do not keep completed implementation checklists as permanent architecture.
Preserve a durable decision, invariant, or research result and rely on Git
history for the completed task sequence.

## Releases

Desktop, Linux server, Docker, Android runtime, npm packages, and the Android APK
have separate publication boundaries. Building one does not authorize or prove
another. Release workflows live in `.github/workflows/`; external publication
requires explicit maintainer authorization.

## Pull Requests

- Keep unrelated worktree changes out of the commit.
- Explain the owning boundary and failure behavior.
- Include focused tests and any broader checks run.
- Separate mock, virtual-radio, packaged-runtime, and real-hardware evidence.
- Call out public contract, persistence, security, RF, and release impact.
