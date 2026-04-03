export interface BuildInfo {
  channel: 'release' | 'nightly';
  version: string;
  commit: string;
  commitShort: string;
  tag: string;
  buildTimestamp: string;
}

export const BUILD_INFO: BuildInfo = {
  channel: 'release',
  version: '1.0.0',
  commit: 'development',
  commitShort: 'development',
  tag: 'development',
  buildTimestamp: '1970-01-01T00:00:00.000Z',
};
