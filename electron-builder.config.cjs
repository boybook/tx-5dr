const path = require('path');
const { getBuilderExtraResources, packageAfterCopy } = require('./scripts/electron-package-hooks.cjs');

const LINUX_SHORT_DESCRIPTION = 'TX-5DR Ham Radio FT8 Application - Digital mode software for amateur radio';
const LINUX_LONG_DESCRIPTION = 'TX-5DR - Shared Node backend + web browser client + optional Electron shell';
const LINUX_DEB_DEPENDS = [
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'xdg-utils',
  'libatspi2.0-0',
  'libdrm2',
  'libgbm1',
  'libxcb-dri3-0',
  'kde-cli-tools | kde-runtime | trash-cli | libglib2.0-bin | gvfs-bin',
];

function normalizeBuilderArch(value) {
  if (typeof value === 'string') return value;
  const archNames = { 0: 'x64', 1: 'ia32', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  return archNames[value] || process.env.ARCH || process.arch;
}

function resolveBuilderPackagePaths(context) {
  const productFilename = context.packager.appInfo.productFilename || 'TX-5DR';
  if (context.electronPlatformName === 'darwin') {
    const resourcesDir = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
    return { appRoot: path.join(resourcesDir, 'app'), resourcesDir };
  }
  const resourcesDir = path.join(context.appOutDir, 'resources');
  return { appRoot: path.join(resourcesDir, 'app'), resourcesDir };
}

module.exports = {
  appId: 'com.tx5dr.app',
  productName: 'TX-5DR',
  executableName: 'tx-5dr',
  artifactName: 'TX-5DR-${version}-${os}-${arch}.${ext}',
  directories: {
    output: 'out/electron-builder',
    buildResources: 'packages/electron-main/assets',
  },
  files: [
    'package.json',
    'packages/**/package.json',
    'packages/**/dist/**',
    'packages/client-tools/src/proxy.js',
    'packages/electron-main/assets/**',
    'node_modules/**',
    '!node_modules/.cache/**',
    '!**/*.map',
    '!**/test/**',
    '!**/tests/**',
    '!**/*.ts',
  ],
  extraResources: getBuilderExtraResources(),
  asar: false,
  npmRebuild: false,
  publish: [{ provider: 'generic', url: 'https://tx5dr.com/updates' }],
  afterPack: async (context) => {
    const { appRoot, resourcesDir } = resolveBuilderPackagePaths(context);
    await packageAfterCopy({
      appRoot,
      resourcesDir,
      platform: context.electronPlatformName,
      arch: normalizeBuilderArch(context.arch),
    });
  },
  mac: {
    category: 'public.app-category.utilities',
    icon: path.join(__dirname, 'packages/electron-main/assets/AppIcon.icns'),
    target: ['dmg', 'zip'],
    artifactName: 'TX-5DR-${version}-macos-${arch}.${ext}',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    identity: process.env.APPLE_IDENTITY || undefined,
    notarize: Boolean(
      process.env.APPLE_ID
      && process.env.APPLE_APP_SPECIFIC_PASSWORD
      && process.env.APPLE_TEAM_ID
    ),
  },
  win: {
    icon: path.join(__dirname, 'packages/electron-main/assets/AppIcon.ico'),
    target: ['nsis', 'zip', '7z'],
    artifactName: 'TX-5DR-${version}-windows-${arch}.${ext}',
    requestedExecutionLevel: 'asInvoker',
    compression: 'normal',
  },
  nsis: {
    artifactName: 'TX-5DR-${version}-windows-${arch}-nsis.${ext}',
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'TX-5DR',
    uninstallDisplayName: 'TX-5DR',
    deleteAppDataOnUninstall: false,
    differentialPackage: true,
    runAfterFinish: true,
  },
  linux: {
    icon: path.join(__dirname, 'packages/electron-main/assets/AppIcon.png'),
    category: 'Utility;AudioVideo',
    packageCategory: 'utils',
    target: ['AppImage', 'deb', 'rpm', 'zip'],
    artifactName: 'TX-5DR-${version}-linux-${arch}.${ext}',
    maintainer: 'BG5DRB <bg5drb@example.com>',
    vendor: 'TX-5DR Team',
    synopsis: LINUX_SHORT_DESCRIPTION,
    // electron-builder derives desktop Comment from linux.description after entry overrides.
    description: LINUX_SHORT_DESCRIPTION,
    desktop: {
      entry: {
        Name: 'tx-5dr',
        Comment: LINUX_SHORT_DESCRIPTION,
        GenericName: 'Ham Radio Application',
        StartupNotify: 'true',
      },
    },
  },
  appImage: {
    artifactName: 'TX-5DR-${version}-linux-${arch}.${ext}',
  },
  deb: {
    packageName: 'tx-5dr',
    priority: 'optional',
    packageCategory: 'utils',
    description: LINUX_LONG_DESCRIPTION,
    depends: LINUX_DEB_DEPENDS,
    recommends: ['pulseaudio | libasound2'],
    fpm: ['--deb-suggests', 'gir1.2-gnomekeyring-1.0', '--deb-suggests', 'libgnome-keyring0', '--deb-suggests', 'lsb-release'],
  },
  rpm: {
    packageName: 'tx-5dr',
    packageCategory: 'utils',
    synopsis: LINUX_SHORT_DESCRIPTION,
    description: LINUX_LONG_DESCRIPTION,
  },
};
