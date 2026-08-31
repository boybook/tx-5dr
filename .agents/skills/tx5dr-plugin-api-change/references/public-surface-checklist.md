# Plugin Public Surface Checklist

## Surfaces

| Surface | Primary owners |
| --- | --- |
| Public types and helpers | `packages/plugin-api/src` |
| Shared wire and persisted schemas | `packages/contracts/src/schema` |
| Runtime-neutral shared logic | `packages/core/src` |
| Host projection, invocation guard, loader, arbitration | `packages/server/src/plugin` |
| Built-in behavior and reference implementations | `packages/builtin-plugins/src` |
| Generated projects | `packages/create-tx5dr-plugin` |
| Human guide | `docs/plugin-system.md` |
| Generated API reference | sibling `tx-5dr-site` repository |

External plugins import from `@tx5dr/plugin-api`. Direct imports from contracts,
core, server internals, or built-in plugins require an explicit public-boundary
decision rather than accidental reach-through.

## Host and Plugin Separation

The Host owns mechanisms that remain meaningful without naming a particular
plugin: lifecycle, authorization, isolated storage, event delivery, stable
state projections, arbitration, and guarded radio/logbook/network operations.
Plugins own feature policy, settings, scoring and exchange rules, provider
behavior, and presentation.

A Host addition prompted by one plugin is acceptable only when it can be
described and tested with neutral domain semantics. Require:

- an explicit public type or structured port;
- declared permission where the operation is privileged;
- runtime input/output validation and detached values;
- a named lifecycle and cleanup owner;
- failure and compatibility semantics;
- tests using a generic plugin fixture rather than the originating plugin;
- public JSDoc and generated-reference coverage.

Reject these hidden contracts:

- `if (plugin.name === ...)` or equivalent built-in identity branches;
- magic EventBus topics, storage keys, settings fields, or payload shapes known
  only to the Host and one plugin;
- undeclared context properties or privileged internal imports;
- Host code that interprets plugin-specific business policy;
- built-in-only fast paths that external plugins cannot reach through the same
  public contract.

Keep the first capability narrow. Neutral and reusable does not mean building a
framework for hypothetical future plugins.

## Contract Rules

- Keep `package.json` exports, declarations, runtime implementation, and JSDoc
  aligned.
- Validate and freeze plugin definitions before activation.
- Derive context types and runtime properties from literal permissions.
- Host queries return detached snapshots. Do not serialize guarded live proxies.
- UI/config/KV payloads are JSON-compatible; hook/EventBus payloads obey the
  documented clone boundary.
- Invocation-scoped capabilities expire after callback settlement, timeout,
  reload, or unload.
- Strategy runtimes return declarative decisions and never own raw device/PTT
  handles.
- Autocall plugins propose; the Host performs stable arbitration and at most one
  resulting call request per decision point.

## Compatibility Gates

Run the subset affected by the change, then broaden:

```bash
yarn workspace @tx5dr/contracts test
yarn workspace @tx5dr/core test
yarn workspace @tx5dr/plugin-api build
yarn workspace @tx5dr/plugin-api test
yarn workspace @tx5dr/plugin-api smoke:pack
yarn workspace @tx5dr/server test:unit
yarn workspace @tx5dr/builtin-plugins test
yarn workspace create-tx5dr-plugin build
```

For scaffold changes, generate a real consumer, install/build it outside the
workspace assumptions, and inspect its output. For marketplace changes, inspect
the actual ZIP: it must be self-contained, checksum-verified, path-safe, and
loadable by the Host.

When public JSDoc changes, run `npm run docs:sync-plugin-api` in the site
repository, check generation idempotence, then run its lint, tests, and build.

## Publication

Before npm publication, confirm exact package versions, repository metadata,
Trusted Publisher configuration, dependency order, and registry propagation.
Publication and marketplace deployment remain separate authorized actions.
