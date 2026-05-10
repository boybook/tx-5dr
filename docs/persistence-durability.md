# Persistence Durability Model

TX-5DR treats confirmed configuration/auth/logbook writes as durable data. Any API or UI action that returns success for these data classes must survive normal restart, Electron relaunch, systemd package upgrade, and Docker stop/update.

## Data Classes

- **Strong-consistency data**: `config.json`, `auth.json`, `.admin-token`, Electron settings, plugin storage, and QSO logbook transactions. Successful mutations are written through a durable commit path.
- **Runtime state**: high-frequency values such as selected frequency, volume gain, engine mode, PSKReporter stats, and auth `lastUsedAt` live in `runtime-state.json` with debounce plus forced shutdown flush.
- **Derived data**: server-ready files, startup logs, caches, and log tails may be rebuilt and are not part of strong recovery.
- **Compatibility snapshots**: `.adi` logbook files remain user-facing ADIF snapshots, but QSO truth is committed first to the JSONL journal.

## Safe JSON Writes

Server JSON stores use `JsonFileStore` over `SafeFileWriter`:

1. Write a unique temp file in the target directory.
2. `fsync` the temp file and close it.
3. Keep rotating backups (`.bak.1` to `.bak.3`).
4. Atomically rename the temp file over the target.
5. Best-effort `fsync` the parent directory on POSIX.
6. Retry transient Windows `EPERM` / `EBUSY` / `EACCES` rename failures.

On load, existing corrupt files are never overwritten with defaults. Recovery tries the main file, newest temp files, then backups. If recovery succeeds, the corrupt file is moved aside as `.corrupt-<timestamp>` and the recovered version is atomically restored. If recovery fails, startup surfaces an error rather than replacing user data.

## Logbook Journal

For each ADIF logbook:

- `<CALL>.adi` is the compatibility snapshot.
- `<CALL>.journal.jsonl` is the append-only primary transaction journal.
- `<CALL>.meta.json` records checkpoint metadata.

`addQSO`, `updateQSO`, `deleteQSO`, and imports append a checksummed transaction and `fsync` the journal before updating memory or returning success. Startup loads the ADIF snapshot and replays the journal. A partial or corrupt journal tail is copied to `.corrupt-<timestamp>` and truncated to the last valid transaction.

Checkpoint runs on the same per-logbook writer queue as mutations. It writes a new ADIF snapshot through the safe writer, updates metadata, then rotates/truncates the journal. This avoids the previous full-rewrite/pending-append race where concurrent saves could clear pending IDs or overwrite newer records.

## Shutdown Coordination

`PersistenceCoordinator` registers config, auth, runtime state, plugin storage, slotpack persistence, and logbook providers. Shutdown flow blocks new mutating HTTP requests, stops the engine/operators, closes logbooks, and calls `flushAll` with a deadline.

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
