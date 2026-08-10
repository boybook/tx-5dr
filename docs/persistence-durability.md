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
- Updates, deletes, and imports that merge existing records are the explicit append-only exception. They stream a complete candidate to a fixed temporary file, validate it, save a fixed last-good copy, and atomically replace the formal file.
- Untouched records retain their physical order and original bytes. Unknown fields, duplicate records, headerless files, and complete opaque records are not normalized merely by opening or rewriting a logbook.

Each mutation is prepared against an immutable in-memory document. The document and indexes change only after the file commit succeeds. If an append fails, TX-5DR attempts to truncate back to the previous EOF and sync it. A failed rollback or an unexpected file generation change puts only that logbook into read-only mode; it never creates an emergency log or reports an in-memory-only success.

Loading and validation run in an isolated worker. Content and expected I/O failures become per-logbook health (`loading`, `healthy`, `degraded`, `read_only`, or `unavailable`) and never control server readiness. A complete but unparseable record is preserved with a warning. An unsafe non-whitespace tail is preserved once as `tail-fragment.bin` before repair.

TX-5DR does not support another program writing the same `.adi` concurrently. A size, timestamp, or content-generation mismatch stops mutations with `LOGBOOK_WRITE_STATE_UNCERTAIN`; external read-only access is supported.

## Logbook Recovery Artifacts

Normal stable logbook directories contain only `.adi` files. Recovery data lives under `.tx5dr-recovery/<path-hash>/` and is bounded:

- `rewrite.tmp` exists only during a rewrite and is deterministically resolved at startup.
- `last-good.adi` is a single rolling pre-rewrite recovery copy.
- `tail-fragment.bin` is a single copy and is removed after 30 continuously healthy days.
- `unrecoverable-original.adi` is a single, never-overwritten user-recovery original and is never deleted automatically.
- `legacy/` contains one quarantined set of recognized journal/meta/backup artifacts. It is removed after 30 days only while the current `.adi` still scans safely.

Legacy discovery uses exact names derived from a known `.adi` basename. Unknown files are never moved or deleted. Migration and cleanup failures remain visible as health issues but do not invalidate a successfully committed `.adi` or block server startup.

## Shutdown Coordination

`PersistenceCoordinator` registers config, auth, runtime state, plugin storage, slotpack persistence, and logbook providers. For logbooks, flush/close only drains the per-file mutation queue; shutdown never creates a checkpoint or rewrites `.adi`. Shutdown flow blocks new mutating HTTP requests, stops the engine/operators, closes logbooks, and calls `flushAll` with a deadline. The server's existing 32-second prepare and 42-second signal budgets also bound logbook close, so a long legacy scan cannot hold process exit for its full worker deadline; any interrupted recovery transaction is resolved from its fixed artifacts on the next open.

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
