export interface ServerBuildInfo {
  channel: 'release' | 'nightly';
  version: string;
  commit: string;
  commitShort: string;
  buildTimestamp: string;
  distribution?: 'electron' | 'docker' | 'linux-service' | 'generic-server' | 'web-dev';
  dockerDigest?: string;
}

export const SERVER_BUILD_INFO: ServerBuildInfo = {
  channel: 'nightly',
  version: '1.0.0',
  commit: 'development',
  commitShort: 'development',
  buildTimestamp: 'development',
};
