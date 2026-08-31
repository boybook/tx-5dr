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

On load, existing corrupt files are never overwritten with defaults. Recovery tries the main file, newest temp files, then backups. If recovery succeeds, the corrupt file is moved aside as `.corrupt-<timestamp>` and the recovered version is atomically restored. If recovery fails, startup surfaces an error rather than replacing user data.

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

## Logbook Backup And Manual Restore

The main `.adi` remains the only source used for startup, queries and sync. A backup is an operator recovery point, never an automatic startup candidate. Each book has one bounded directory:

- `.tx5dr-backups/<basename>/latest.adi` is the most recent validated fixed-EOF snapshot.
- `latest.json` stores only integrity metadata, an internal path fingerprint, record counts and the source revision.
- `pre-restore.adi` is the single raw main-file copy made immediately before an administrator commits a manual restore.
- Fixed temporary files are replaced or removed deterministically and never accumulate generations.

The backup refreshes after 30 minutes or 100 successful mutations, whichever comes first, and is attempted during graceful shutdown. Backup failure never blocks append; it blocks only a rewrite that lacks the required safe snapshot. Restore requires administrator authorization, an `If-Match` revision, a ten-minute one-use preview token, revalidation of both main and backup, and a durable `pre-restore.adi`. TX-5DR never restores automatically.

Legacy discovery uses exact names derived from a known `.adi` basename. Old journal/meta/last-good artifacts are quarantined without replay; unknown files are never moved or deleted. A legacy directory is removed after 30 days only while both main and latest backup still scan safely. A recognized `unrecoverable-original.adi` is kept at most once and never deleted automatically.

## Shutdown Coordination

`PersistenceCoordinator` registers config, auth, runtime state, plugin storage, slotpack persistence, and logbook providers. For logbooks, flush drains the per-file mutation queue; close may spend the remaining 30-second deadline refreshing the optional backup but never rewrites `.adi`. Shutdown flow blocks new mutating HTTP requests, stops the engine/operators, closes logbooks, and calls `flushAll` with a deadline.

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
