---
name: tx5dr-radio-change
description: Implement or review TX-5DR radio backends, capabilities, meters, power, PTT, audio, spectrum, connection lifecycle, and timing-sensitive RF behavior. Use for Hamlib, ICOM WLAN, TCI, and virtual-radio changes; not for UI-only wording or ordinary plugin logic.
---

# TX-5DR Radio Change

Keep hardware protocol details inside the owning adapter and keep RF decisions
inside the server's guarded orchestration boundary.

## Workflow

1. Inspect the current connection contract, owning implementation, manager, and
   nearby tests. Do not implement from an old design document alone.
2. State which axis changes: software engine, radio connection, physical radio
   power, operating state, audio, spectrum, meter, or dynamic capability.
3. Read [references/boundaries-and-tests.md](references/boundaries-and-tests.md)
   for the relevant boundary and its guard tests.
4. Keep protocol parsing/retry logic in the public protocol library when one
   exists; keep TX-5DR Profile, lifecycle, permission, and event projection in
   this repository.
5. Add failure-path tests before broad integration tests. Cover stale sessions,
   unsupported capabilities, disconnects, and command interleaving when they
   are in scope.
6. Run focused workspace tests, then expand to server lint/test/build according
   to blast radius.

Never key a real radio, change physical power, or perform an on-air test without
explicit user authorization for that hardware action. A mocked or virtual-radio
test does not authorize live RF.

Report separately what was proven by unit tests, virtual integration, native
module loading, and real hardware.
