# Contest Logbook UI Boundary

Status: accepted

Contest logbooks are a public Plugin API capability. The canonical operator
page is built and published with `@tx5dr/plugin-api`, then copied into each
plugin artifact by the scaffold or Marketplace plugin build. A plugin declares the
capability with `standardFT8ContestLogbook()` or `defaultContestLogbook()`;
authors do not copy a private WW Digi page or hand-write the standard panel and
page descriptors.

The Host remains responsible for page authentication, operator binding, page
sessions, the iframe bridge and static file serving. It does not provide a
contest page itself and never branches on a contest or plugin name. Contest
plugins own only rule policy: settings, exchange projection, review decisions,
scoring and submission formatting.

Contest definitions may also expose operator-facing `presentation` metadata: a
concise rule summary, scoring summary, and exchange description. The shared page
renders this metadata with localized labels, collapsible rule and scoring
sections, and a validated HTTP link to the authoritative rules source from the
edition. The URL remains the source of truth; the summary is informational and
is never used for eligibility or scoring.

The contest session is the authoritative logbook for contest QSO completion.
The composer decorates strategy completion effects with the contest envelope
and session destination before the Host performs its durable write. After the
write, the shared module publishes `stateChanged` to active page sessions.

The same module also owns the contest-specific FrameTable presentation index.
It is rebuilt from the contest session after session open, durable QSO
completion, import, review changes, and edition rebinding. The composer overlays
that projection on the strategy snapshot, so the operator sees new callsign and
contest multiplier tags from the independent contest logbook rather than from
the station's primary logbook.
