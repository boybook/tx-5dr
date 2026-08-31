---
name: tx5dr-plugin-api-change
description: Change or review TX-5DR's public Plugin API, Host projection, scaffold, marketplace packaging, generated reference, or npm compatibility. Use for public plugin contracts and releases; not for an isolated plugin that only consumes the existing API.
---

# TX-5DR Plugin API Change

Treat the packed third-party consumer as the compatibility boundary, not the
monorepo workspace alone.

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

If a plugin need reveals a missing Host capability, give the capability neutral
semantics, explicit permission and validation, lifecycle ownership, public
types/JSDoc, and tests with a generic plugin fixture. Built-in plugins receive
no privileged hidden path.

Publishing npm packages, marketplace archives, or releases requires explicit
authorization. Preserve the dependency order and wait for registry propagation
between dependent packages.
