const injectedVersion = (import.meta.env as { PACKAGE_VERSION?: string }).PACKAGE_VERSION;

export const CLIENT_BUILD_VERSION = typeof injectedVersion === 'string' && injectedVersion.trim()
  ? injectedVersion.trim()
  : undefined;
