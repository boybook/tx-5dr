---
name: tx5dr-plugin-api-change
description: Change or review TX-5DR's public Plugin API, Host projection, scaffold, marketplace packaging, generated reference, or npm compatibility. Use for public plugin contracts and releases; not for an isolated plugin that only consumes the existing API.
---

# TX-5DR Plugin API Change

Treat the packed third-party consumer as the compatibility boundary, not the
monorepo workspace alone.

Audio peer scenarios use the shared public declaration and Host execution;
see [station testing](../../../docs/architecture/station-testing.md). Do not add
plugin-specific test backdoors or raw device handles. Native/codec and real-slot
checks are explicitly selected development validation, not unit tests or default
CI. Read [station validation](../tx5dr-development/references/station-validation.md)
when that development evidence is needed, including target-plugin identity,
plugin session persistence, UI preparation and page-session renewal after reload.

## Workflow

1. Identify whether the change is public API, Host-only implementation,
   built-in plugin behavior, scaffold output, marketplace format, or generated
   documentation. Separate plugin-specific policy from a reusable Host
   mechanism. Do not widen the public surface to solve an internal problem.
2. Inspect current `exports`, public JSDoc, runtime validation, Host projection,
   and packed-consumer tests before choosing the change.
3. Read [references/public-surface-checklist.md](references/public-surface-checklist.md)
   for the affected surface and compatibility gates.
4. Keep permissions literal and capability-derived. Strategy decisions remain
   declarative; privileged utility operations use structured Host ports.
   Never add a Host branch keyed by plugin identity or a private Host/plugin
   convention that is absent from the public contract.
5. Pass data across Host/plugin/UI boundaries by detached serializable value.
   Invocation-scoped Host handles must not escape their callback lifetime.
6. Update public JSDoc and examples with the implementation. Regenerate the
   website reference when the sibling `tx-5dr-site` checkout is available and
   the task includes documentation delivery.
7. Validate the actual tarball or marketplace archive, not only source imports.

## Plugin API versioning and marketplace compatibility

The marketplace installs a plugin version when the bundled Plugin API satisfies
`^minPluginApiVersion` (`isPluginApiCompatible`). The loader also accepts the
previous major as `legacy` (`PLUGIN_API_LEGACY_MAJOR_WINDOW`) so a stricter rule
never silently disables working installations; plugins it rejects appear in
the snapshot's `loadFailures`. Keep `getPluginApiCompatibility`, the
`tx5dr-plugin check` CLI (a bin of `@tx5dr/plugin-api`; never document it as
`npx tx5dr-plugin`, which would fetch an unrelated package of that name) and the
plugin repository validator on the same rules.
The marketplace has no release channel: Hosts install the newest non-yanked
version compatible with their Plugin API from the full version history.
Therefore:

- Any added or changed public capability, permission, hook, slot or context
  field requires a `@tx5dr/plugin-api` version increase in the same change.
  A Host that carries an API under an unchanged version number is
  indistinguishable from one that does not.
- A breaking change requires a new major. Plugins declaring the previous major
  then load only as `legacy`, and the major before that stops loading. Before
  releasing such a Host, migrate and publish the official marketplace plugins,
  and state the change in the release notes.
- A plugin's `minPluginApiVersion` must not be lower than the `@tx5dr/plugin-api`
  range it (or a bundled shared package) builds against. Keep the scaffold's
  dependency range and declared floor identical.
- Published plugin versions are immutable. Changing packaged content needs a
  new plugin version; withdraw a bad one with `yanked` in the plugin repository
  registry instead of replacing bytes.
- Hosts released before schema v3 read `<channel>/index.json`. Keep that legacy
  output until those Hosts are no longer supported; do not remove it as part of
  an unrelated change.
- The SDK train (`@tx5dr/contracts`, `@tx5dr/core`, `@tx5dr/plugin-api`,
  `create-tx5dr-plugin`) shares one version, and that version is the Host's
  plugin compatibility axis. A major increase therefore moves every published
  plugin to `legacy` and removes plugins two majors behind. Raise the major only for a breaking change to the plugin-facing
  surface exported by `@tx5dr/plugin-api`. Contracts/core schemas and clients
  that only Host processes use (marketplace, route payloads, UI projections)
  are not part of the plugin SemVer promise; change them with a minor increase
  and record the change in the SDK release notes.

If a plugin need reveals a missing Host capability, give the capability neutral
semantics, explicit permission and validation, lifecycle ownership, public
types/JSDoc, and tests with a generic plugin fixture. Built-in plugins receive
no privileged hidden path.

Publishing npm packages, marketplace archives, or releases requires explicit
authorization. Preserve the dependency order and wait for registry propagation
between dependent packages.
