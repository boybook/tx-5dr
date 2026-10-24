# Release identity and update ownership

The root package version is the Host version source. Plugin SDK and Android APK versions are independent. A formal Host release is identified by an immutable `vX.Y.Z` tag matching the source version and exact commit. Desktop, Linux Server, Android Runtime and Docker consume that commit. Only the coordinator publishes channel pointers after all required product builds pass. Development branch verification does not publish.

Immutable assets live below `tx-5dr/<product>/builds/<version>/`. Versioned manifests carry full source SHA, channel, product, version, assets and integrity metadata. Missing `schema_version` identifies the legacy decoder. Consumers validate the requested product and channel. CDN failure can fall back to GitHub for the same channel, never another channel. The stable website catalog is committed last. A GitHub Release alone is not distribution success.

Installed channel and subscribed channel are separate facts. Selecting a channel persists a preference and checks its manifest; it never installs. A prepared update binds the exact version, commit, URLs and checksums. Changing channels invalidates pending work. Cross-channel downgrades require explicit confirmation and a successful backup; same-channel checks do not recommend older versions. Data compatibility and third-party plugin compatibility are not implied by SemVer.

Owners:

Packaged build identity determines the distribution and update path. A Linux Server package installed inside a container remains a Linux service; the presence of `/.dockerenv` alone must not select Docker image updates. Environment and directory detection remain for unpackaged builds.

- Electron main owns settings, downloads, install handoff and backup after embedded-server shutdown. Renderer IPC is limited to the application's top-level local pages. The embedded Server does not own desktop update preferences.
- Linux Server and its CLI share `update-preferences.json` through the same Node implementation. The web API only changes preferences. The administrator runs the privileged CLI locally. CLI writes preserve configuration ownership. The CLI owns SemVer approval; RPM applies that confirmed target with `--oldpackage` because native package ordering differs from SemVer.
- Android owns runtime preferences and installation in the native shell. `android-update-state.json` is an explicit read-only projection to the Server. WebView can navigate to native updates only from the local top-level application page. External browsers cannot invoke native installation. APK updates preserve package/signing identity and require increasing versionCode independently of runtime channel.
- Docker preferences choose the proposed target only. An operator changes the actual container image by immutable digest and preserves the data volume. No Docker socket is exposed to the application.

Updates stop RF and drain persistence through the owning lifecycle before replacing executable files. Backups are kept outside install directories. Failed downloads leave the installed version intact. Failed startup may restore executable selection, but never silently overwrite user data with an old snapshot. Data restoration is a separate, explicit operation that discards post-backup changes.

Rolling nightly release assets remain a legacy compatibility surface. Their tag is not immutable source evidence. Older clients first receive a transition nightly; newer clients retain their selected channel until the user changes it. `stable` and `latest` Docker tags represent formal releases; `nightly` remains the explicit development subscription.
