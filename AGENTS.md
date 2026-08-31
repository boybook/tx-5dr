# TX-5DR Repository Guidance

## Scope

TX-5DR is a Yarn 4 / Turborepo monorepo for a browser-operated amateur-radio
station. The server owns radio, audio, timing, logbook, and plugin state; Web,
Electron, Linux/Docker, and the Android runtime consume the same server and
contracts.

## Worktree Safety

- Work in the current primary checkout by default. Do not create or switch to a
  Git worktree unless the user explicitly requests one.
- Assume existing modified and untracked files belong to the user.
- Do not clean, reset, stash, broadly stage, or rewrite unrelated changes.
- Stage an exact file allowlist. Keep source, npm publication, deployment, and
  release operations separate unless the user explicitly authorizes each one.
- Treat investigation and review requests as read-only.

## Repository Map

- `packages/contracts`: Zod schemas and cross-process types.
- `packages/core`: runtime-neutral clients, clocks, parsers, and shared logic.
- `packages/server`: Fastify API, radio/audio engine, persistence, and plugin Host.
- `packages/web`: React UI and browser-side state projection.
- `packages/electron-main`, `packages/electron-preload`: desktop host boundary.
- `packages/plugin-api`: stable public plugin imports and testing helpers.
- `packages/builtin-plugins`: plugins shipped with the application.
- `packages/rigctld-server`: reusable NET rigctl TCP server.
- `packages/client-tools`: production/Android static entry and API proxy.
- `docs`: maintained engineering contracts, decisions, and research evidence.

## Sources of Truth

- Runtime schemas, implementation, and tests outrank prose documentation.
- Public plugin authors import from `@tx5dr/plugin-api`, not internal server or
  monorepo paths.
- User installation and operation documentation belongs in
  `boybook/tx-5dr-site`; do not create a competing operator guide here.
- Keep implementation plans out of maintained architecture documents. Record a
  durable decision or invariant, then rely on issues and Git history for progress.

## Engineering Decisions

- Aim for designs that are simple, cohesive, and unsurprising: one clear owner,
  explicit state and failure semantics, stable narrow interfaces, and as few
  exceptional branches as the domain allows. Elegance is clarity and economy,
  not the number of abstractions.
- Before adding a feature or fixing a bug, identify the owning boundary and the
  invariant that should govern the behavior. Prefer correcting that boundary to
  stacking a symptom-specific patch on top of the wrong owner.
- Choose the smallest coherent architectural change. Do not preserve a flawed
  design merely to finish quickly, but do not turn one requirement into a broad
  redesign of unrelated modules.
- Expand the architecture only when the existing abstraction cannot express the
  requirement cleanly. State the intended boundary, migration impact, and tests
  before changing multiple packages or lifecycle owners.
- Keep compatibility shims and temporary fallbacks explicit, scoped, and
  removable. Do not let them silently become a second architecture.
- Avoid clever indirection, hidden coupling, speculative generalization, and
  frameworks introduced for hypothetical future needs. Prefer code whose data
  flow and cleanup behavior can be understood from its owning module and tests.
- When a change moves ownership, alters a lifecycle, changes a cross-process
  contract, or materially changes event/data flow, update the corresponding
  maintained document under `docs` in the same change. Ordinary implementation
  details do not require architecture-document churn.

## Non-Negotiable Invariants

- Use Yarn through the repository's pinned `packageManager`; do not create an
  npm lockfile in this monorepo.
- Cross-process data requires a runtime schema or explicit decoder, not only a
  TypeScript interface.
- All radio protocol I/O goes through the owning connection's serialized queue.
  Frequency/mode changes use a compound operating-state operation when available.
- Software engine state, radio connection state, and physical radio power are
  separate axes. Do not map one to another implicitly.
- RF automation fails closed when identity, slot, permission, or radio state is
  incomplete. Plugins submit decisions through the Host; they do not bypass it
  for raw PTT or device ownership.
- Keep Host and plugin responsibilities explicit. The Host provides generic,
  declared, permissioned, and testable mechanisms; plugins own feature policy,
  settings, and presentation. Do not branch on a plugin name or rely on private
  events, magic keys, undocumented context fields, or built-in-only shortcuts.
  A new Host capability must have neutral semantics and a public contract that
  another external plugin could use without knowing the original plugin.
- Frontend user-visible text uses i18n. Keep `zh`, `en`, and `ja` resources aligned
  and run `yarn check:i18n` after UI text changes.
- Use each package's `createLogger`; messages are English and contain no emoji.
  Do not add bare `console.log` calls to application code.
- Preserve authentication, authorization, HTTPS/origin policy, secret redaction,
  and persistence durability unless the requested change explicitly owns them.

## Validation

Run focused checks while iterating, then broaden according to blast radius:

```bash
yarn lint
yarn test
yarn build
yarn check:i18n
```

Useful focused checks include:

```bash
yarn workspace @tx5dr/server test:unit
yarn workspace @tx5dr/server test:virtual-radio-integration
yarn workspace @tx5dr/plugin-api test
yarn workspace @tx5dr/plugin-api smoke:pack
yarn workspace @tx5dr/web test
```

Native-module, packaging, platform, and real-radio claims require evidence from
the relevant runtime or artifact; mock tests alone are not sufficient.

## Task-Specific Guidance

Repository skills under `.agents/skills` provide detailed procedures only when
the task matches them:

- `tx5dr-radio-change`: radio backends, capabilities, meters, power, audio, and
  timing-sensitive RF changes.
- `tx5dr-plugin-api-change`: public Plugin API, Host boundary, scaffold,
  marketplace, generated docs, and npm compatibility.
- `tx5dr-release`: desktop, server, Docker, Android runtime, and npm releases.

Maintained engineering documents are indexed in `docs/README.md`.
