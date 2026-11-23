# Privacy and diagnostic data

TX-5DR's anonymous runtime statistics and manual diagnostic uploads are separate features.

Anonymous runtime statistics contain the application version, release channel, runtime type, operating-system family, CPU architecture, process lifecycle, uptime, and connection count. They do not contain callsigns, QSO records, frequencies, audio, host or user names, local paths, or log contents. Existing installations send no statistics until an administrator acknowledges the notice, and the setting can be disabled later.

Diagnostic logs are never uploaded automatically. An administrator must select one supported log source and a time range, may add a short problem description, and then press the upload button for that submission. Logs can contain troubleshooting context such as callsigns, frequencies, network addresses, host information, and local paths. TX-5DR removes credentials, authorization headers, tokens, and registered sensitive values again before upload.

Diagnostic log objects are stored in private encrypted storage and deleted after 30 days. Searchable diagnostic metadata does not include the log body.

The public station identity (`GET /api/station/identity`) lets desktop clients check which build they are connecting to before signing in. It contains the product name, a random station instance ID, the application version, source commit, release channel, runtime type, whether authentication and public viewing are enabled, and the required desktop bridge version. The instance ID is generated for this purpose only and is not the anonymous statistics identifier. The identity contains no callsigns, station profile, host or user names, network addresses, or local paths.

When the remote access preset allows network access, an installed server or desktop station announces itself on the local network (DNS-SD `_tx5dr._tcp`) so desktop clients can find it. The announcement contains a version number, the random station instance ID, the protocol and the web port; it contains no callsign, station profile, user or host names. Docker, Android and development servers do not announce by default, and `TX5DR_DISCOVERY=0` turns it off. Desktop clients browse only while their station manager is open.
