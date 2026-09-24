# Persistence Durability Model

TX-5DR treats confirmed configuration/auth/logbook writes as durable data. Any API or UI action that returns success for these data classes must survive normal restart, Electron relaunch, systemd package upgrade, and Docker stop/update.

## Data Classes

- **Strong-consistency data**: `config.json`, `auth.json`, `.admin-token`, Electron settings, plugin storage, and QSO logbook transactions. Successful mutations are written through a durable commit path.
- **Runtime state**: high-frequency values such as selected frequency, volume gain, engine mode, PSKReporter stats, and auth `lastUsedAt` live in `runtime-state.json` with debounce plus forced shutdown flush.
- **Derived data**: server-ready files, startup logs, caches, and log tails may be rebuilt and are not part of strong recovery.
- **QSO logbooks**: the user-visible `.adi` file is the only current source of truth. There is no normal-operation journal or checkpoint sidecar.

## Safe JSON Writes

Server JSON stores use `JsonFileStore` over `SafeFileWriter`:

1. Write a unique temp file in the target directory.
2. `fsync` the temp file and close it.
3. Keep rotating backups (`.bak.1` to `.bak.3`).
4. Atomically rename the temp file over the target.
5. Best-effort `fsync` the parent directory on POSIX.
6. Retry transient Windows `EPERM` / `EBUSY` / `EACCES` rename failures.

On load, existing corrupt files are never overwritten with defaults. Recovery tries the main file, then existing temp files and backups ordered by modification time. A missing main file does not bypass surviving recovery candidates. Only `ENOENT` means absence; permissions and I/O failures must not create defaults. Before replacing a corrupt main file, its bytes are durably copied to `.corrupt-<sha256>`; failure to preserve them aborts recovery. Recovery does not rotate away its source candidate. The default policy remains strict: unrecoverable critical configuration/auth data raises a classified error rather than being reset. Optional feature owners must contain that error within their own availability boundary.

## Image Feature Persistence

Image metadata is durable user data owned by the optional image feature, not a
prerequisite for server readiness. `ImagePersistenceCoordinator` owns one shared
initialization promise for artifacts, history, templates, composer backgrounds
and transmit preferences. Every store is attempted; only after all are usable
may history reconciliation and image operations begin. An unrecoverable store
makes image operations unavailable for that process lifetime, without preventing
HTTP/WebSocket readiness, settings access, or other radio modes. Repair is retried
on restart, not by each API request.

Disk collections use an explicit `schemaVersion` and server-owned record decoders,
separate from API envelopes. Unversioned data is v0 and known historical values
are migrated before validation; v1 is the current write format. A future version
is never replaced by defaults or an older backup. Critical values such as identity
and frequency are never invented to make an invalid record pass validation.

Image recovery first prefers a complete migrated main file, then the newest
complete backup/temp candidate. Otherwise it salvages individually valid records
from the main collection, or the newest decodable candidate if the main collection
cannot be decoded. It never merges generations or silently chooses between
conflicting identities. If nothing survives, it creates an empty collection.
Built-in templates and preference defaults remain business-layer defaults.

Before migration or repair, raw candidates are durably archived under
`image-radio/recovery/<filename>/<sha256>.original`, together with a deterministic
report containing source names, validation paths/codes and recovery counts. These
archives are deduplicated by content, excluded from backup rotation, and never
automatically deleted. Archive/report/commit failure leaves the original main file
unchanged and disables the image feature. Recovery never deletes image or asset
files or runs quota eviction. Normal quota enforcement only considers current
indexed artifacts, never unreferenced files or recovery archives.

Each collection serializes complete read-modify-write transactions, validates the
candidate before writing, and publishes memory only after the atomic file commit.
Deletion commits metadata before unlinking PNGs. Composer backgrounds use immutable
content-addressed assets for new records; legacy background paths remain readable.
Cross-collection commits are not atomic: reconciliation may repair received-image
history, and a cleanup failure may leave an unreferenced file, but never justifies
clearing another collection or reporting a failed disk write as successful.

Public image status carries schema-validated persistence health and recovery
counts, independently of native codec availability. Unavailable operations return
`IMAGE_PERSISTENCE_UNAVAILABLE` before acquiring playback/PTT resources. Clients
show one persistent contextual notice rather than repeated notifications. Full
filesystem paths and original data remain server-side.

Every added image collection or disk-format change must include old-format fixtures,
write/reload tests, failed-commit tests, and startup-isolation tests. Shared recovery
changes must also keep the strict auth/config recovery tests passing.

## ADIF Logbook Commits

For each ADIF logbook:

- `<CALL>.adi` is the sole formal data source and remains readable while TX-5DR is running.
- A newly created QSO is written with `O_APPEND`, checked for a complete write, and `fsync`ed before the operation reports success.
- Updates, deletes, and imports that merge existing records are the explicit append-only exception. They require a valid rolling backup when the backup is missing or stale, then stream and validate a complete candidate before atomically replacing the formal file.
- Parent-directory synchronization after creating, replacing, or restoring an ADIF file is best-effort. An expected platform limitation does not degrade a verified logbook; an unexpected synchronization failure remains visible as a durability warning.
- Untouched records retain their physical order and original bytes. Unknown fields, duplicate records, headerless files, and complete opaque records are not normalized merely by opening or rewriting a logbook.

Each mutation is prepared against an immutable in-memory document. The document and indexes change only after the file commit succeeds. If an append fails, TX-5DR attempts to truncate back to the previous EOF and sync it. Only a failed rollback or content state that cannot be determined puts that logbook into read-only mode; it never creates an emergency log or reports an in-memory-only success.

Loading and validation run in an isolated worker. Content and expected I/O failures become per-logbook health (`loading`, `healthy`, `degraded`, `read_only`, or `unavailable`) and never control server readiness. A complete but unparseable record is preserved with a warning. An unsafe non-whitespace tail is left untouched and opens read-only for explicit operator action.

TX-5DR does not support another program writing the same `.adi` concurrently. Size and content hashes define the revision used by prepared mutations; inode, device and mtime are diagnostic metadata only and never lock a healthy logbook. External read-only access is supported.

## QSO Completion Ownership

`QsoCompletionService` owns accepted automatic QSO writes, their frozen destination
and candidate, recovery attempts, and durable outcomes. Admission is asynchronous
with respect to disk completion: the final protocol reply must not wait for a
logbook write. The existing per-operator ordering and per-file mutation queue
remain in force.

An operation is correlated by operator, strategy instance generation, stream,
QSO lifecycle and original record ID. Duplicate submissions join the same task;
a different payload under that identity is rejected. A merged logbook record's
ID is separate from the effect's original record ID. Successful operations release
their full candidate after notifications finish, retaining only compact outcome
information until the producer is retired. Active/recovery status queries index
live tasks rather than scanning the accumulated completed contacts.

Queued or saving tasks become visibly slow after five seconds. Slowness is not a
write failure and never starts another writer or cancels an in-progress fsync.
Only a definitively failed attempt can be explicitly retried or discarded.
Uncertain file outcomes require logbook recovery. Post-commit notifications and
remote synchronization cannot change a committed task back into a failed write.

Durable results and physical-transmission receipts are facts, not speculative
strategy state. The Host delivers them outside the operator's checkpoint/decision/
rollback transaction through a non-coalescing fact inbox. Paused recipients retain
their facts; retired or quarantined instances do not receive them. A fact never
grants transmit permission or replays an earlier rejected call. Standard QSO
retains a stable completion identity through TX4/TX5 and final-73 retries, while
its save and physical confirmations survive protocol checkpoint restoration.

`OperatorStatus.qsoPersistence` is the optional Host projection for saving, slow,
failed and uncertain work. It does not use the strategy's general transmit gate,
which would also suppress a legitimate final reply. Rejected manual calls return
a localized error to the requesting connection.

These task records are in-memory coordination state, not another logbook or a
crash-replay journal. Only a verified ADIF commit is reported as saved. A hard
process exit can still lose a record which has not reached durable storage.

## Logbook Backup And Manual Restore

The main `.adi` remains the only source used for startup, queries and sync. A backup is an operator recovery point, never an automatic startup candidate. Each book has one bounded directory:

- `.tx5dr-backups/<basename>/latest.adi` is the most recent validated fixed-EOF snapshot.
- `latest.json` stores only integrity metadata, an internal path fingerprint, record counts and the source revision.
- `pre-restore.adi` is the single raw main-file copy made immediately before an administrator commits a manual restore.
- Fixed temporary files are replaced or removed deterministically and never accumulate generations.

The backup refreshes after 30 minutes or 100 successful mutations, whichever comes first, and is attempted during graceful shutdown. Backup failure never blocks append; it blocks only a rewrite that lacks the required safe snapshot. Restore requires administrator authorization, an `If-Match` revision, a ten-minute one-use preview token, revalidation of both main and backup, and a durable `pre-restore.adi`. TX-5DR never restores automatically.

Legacy discovery uses exact names derived from a known `.adi` basename. Old journal/meta/last-good artifacts are quarantined without replay; unknown files are never moved or deleted. A legacy directory is removed after 30 days only while both main and latest backup still scan safely. A recognized `unrecoverable-original.adi` is kept at most once and never deleted automatically.

## Shutdown Coordination

`PersistenceCoordinator` registers config, auth, runtime state, plugin storage,
slotpack persistence, QSO completions, and logbook providers. Shutdown closes new
completion admission, stops the engine/operators, drains accepted completion
tasks, then closes logbooks and calls `flushAll` within the existing deadline.
Draining includes tasks which have not yet reached the provider's file queue.
An internal admission scoped to the original logbook allows these accepted writes
to finish after new mutations are blocked; it expires at completion and is never
available to a plugin or HTTP caller. Unresolved or timed-out QSO writes make
prepare-shutdown fail and signal shutdown exit unsuccessfully.

For logbooks, flush drains the per-file mutation queue; close may spend the
remaining deadline refreshing the optional backup but never rewrites `.adi`.
Deleting a logbook or destroying a runtime contest logbook is rejected while it
has accepted or unresolved QSO tasks. Engine stop alone retains those tasks.

- Server `SIGINT` / `SIGTERM`: block mutations, stop engine, close logbooks, flush coordinator, then exit.
- Electron quit/restart: call `POST /api/system/internal/prepare-shutdown` with the random internal token before terminating the embedded server child.
- systemd: `TimeoutStopSec=45s` gives the server time to drain writes during restart/upgrade.
- Docker/supervisor: TERM is forwarded to the server child and `stop_grace_period` / `stopwaitsecs` are 45 seconds.

## Platform Paths

- Windows Electron: config in `%APPDATA%\\TX-5DR`, data/logbooks in `%LOCALAPPDATA%\\TX-5DR`; user data must not be stored under Program Files.
- macOS Electron: config/data in `~/Library/Application Support/TX-5DR`, logs in `~/Library/Logs/TX-5DR`.
- Linux Electron: XDG config/data directories; Electron injects `TX5DR_CONFIG_DIR` / `TX5DR_DATA_DIR` / `TX5DR_LOGS_DIR` / `TX5DR_CACHE_DIR` into the embedded server so a desktop app never accidentally uses `/etc/tx5dr/config.env` headless-service paths.
- Linux server: `/etc/tx5dr/config.env` sets `TX5DR_CONFIG_DIR=/var/lib/tx5dr/config`, `TX5DR_DATA_DIR=/var/lib/tx5dr`, `TX5DR_LOGS_DIR=/var/lib/tx5dr/logs`, and `TX5DR_CACHE_DIR=/var/lib/tx5dr/cache`.
- Docker: durable state is under the `/app/data` volume.
