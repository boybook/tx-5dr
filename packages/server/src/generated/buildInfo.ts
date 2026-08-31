import buildInfo from './buildInfo.json' with { type: 'json' };

export interface ServerBuildInfo {
  channel: 'release' | 'nightly';
  version: string;
  pluginApiVersion: string;
  commit: string;
  commitShort: string;
  buildTimestamp: string;
  distribution?: 'electron' | 'docker' | 'android-bridge' | 'linux-service' | 'generic-server' | 'web-dev';
  dockerDigest?: string;
}

export const SERVER_BUILD_INFO = Object.freeze(buildInfo as ServerBuildInfo);
