export interface BuildInfo {
  channel: 'release' | 'nightly';
  version: string;
  commit: string;
  commitShort: string;
  tag: string;
  buildTimestamp: string;
}

// Electron Main is CommonJS; runtime require preserves the package export
// boundary without creating a second generated build identity.
const canonicalBuildInfo = require('@tx5dr/server/build-info.json') as Omit<BuildInfo, 'tag'>;
const hostBuildInfo = canonicalBuildInfo;

export const BUILD_INFO: BuildInfo = Object.freeze({
  channel: hostBuildInfo.channel,
  version: hostBuildInfo.version,
  commit: hostBuildInfo.commit,
  commitShort: hostBuildInfo.commitShort,
  tag: hostBuildInfo.channel === 'nightly' ? 'nightly-app' : hostBuildInfo.version,
  buildTimestamp: hostBuildInfo.buildTimestamp,
});
