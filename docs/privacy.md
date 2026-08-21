# Privacy and diagnostic data

TX-5DR's anonymous runtime statistics and manual diagnostic uploads are separate features.

Anonymous runtime statistics contain the application version, release channel, runtime type, operating-system family, CPU architecture, process lifecycle, uptime, and connection count. They do not contain callsigns, QSO records, frequencies, audio, host or user names, local paths, or log contents. Existing installations send no statistics until an administrator acknowledges the notice, and the setting can be disabled later.

Diagnostic logs are never uploaded automatically. An administrator must select one supported log source and a time range, may add a short problem description, and then press the upload button for that submission. Logs can contain troubleshooting context such as callsigns, frequencies, network addresses, host information, and local paths. TX-5DR removes credentials, authorization headers, tokens, and registered sensitive values again before upload.

Diagnostic log objects are stored in private encrypted storage and deleted after 30 days. Searchable diagnostic metadata does not include the log body.
