const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function rmGlob(parentDir, prefix) {
  try {
    if (!fs.existsSync(parentDir)) return;
    for (const entry of fs.readdirSync(parentDir)) {
      if (entry.startsWith(prefix)) {
        rmrf(path.join(parentDir, entry));
      }
    }
  } catch {
    // ignore
  }
}

function cleanDirKeep(dir, keepNames) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (!keepNames.includes(entry)) {
        rmrf(path.join(dir, entry));
      }
    }
  } catch {
    // ignore
  }
}

function findAndRemoveDirs(rootDir, targetName) {
  try {
    if (!fs.existsSync(rootDir)) return;
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      const fullPath = path.join(rootDir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === targetName) {
        rmrf(fullPath);
      } else {
        findAndRemoveDirs(fullPath, targetName);
      }
    }
  } catch {
    // ignore
  }
}

function removeFilesByExt(dir, ext) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeFilesByExt(fullPath, ext);
      } else if (entry.name.endsWith(ext)) {
        try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

function removeFilesByPrefix(dir, prefix) {
  const lowerPrefix = prefix.toLowerCase();
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeFilesByPrefix(fullPath, prefix);
      } else if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
        try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

function findFilesByExt(dir, ext) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFilesByExt(fullPath, ext));
      } else if (entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getBuilderExtraResources() {
  return [
    { from: 'resources/bin', to: 'bin' },
    { from: 'resources/licenses', to: 'licenses' },
    { from: 'resources/models', to: 'models' },
    { from: 'resources/README.txt', to: 'README.txt' },
    { from: 'packages/electron-main/assets', to: 'assets' },
  ];
}

function pruneNodeModules(nm) {
  console.log('Pruning packaged node_modules...');
  const scopeDirsToRemove = [
    '@electron', '@electron-builder',
    '@rollup', '@esbuild', '@vitejs', '@swc', '@turbo',
    '@types', '@eslint', '@eslint-community', '@typescript-eslint',
    '@heroui', '@heroicons', '@fortawesome', '@react-aria', '@react-stately', '@react-types', '@formatjs', '@babel',
    '@jridgewell', '@internationalized',
    '@vitest', '@statelyai', '@clinic', '@tensorflow',
    '@malept', '@gar', '@hapi', '@jest',
  ];
  const packageDirsToRemove = [
    'electron', 'electron-winstaller', 'electron-builder', 'builder-util', 'app-builder-lib',
    'rollup', 'vite', 'esbuild', 'postject', 'sucrase', 'appdmg', 'jiti', 'turbo',
    'typescript', 'eslint', 'prettier',
    'caniuse-lite', 'tailwindcss', 'tailwind-merge', 'tailwind-variants',
    'react', 'react-dom', 'framer-motion', 'rxjs',
    'png-to-ico', 'vitest', 'tsx', 'node-gyp', 'electron-installer-redhat', 'electron-installer-debian', 'segfault-handler',
    'superjson', 'lodash', 'axios',
    'postcss', 'autoprefixer', 'lilconfig', 'postcss-load-config',
    'react-refresh', 'react-is', 'scheduler', 'yaml', 'csstype',
    'motion-dom', 'motion-utils',
    'esquery', 'graphemer', 'espree', 'esrecurse', 'estraverse', 'estree-walker', 'esutils',
    'acorn', 'acorn-jsx', 'acorn-walk', 'doctrine', 'optionator',
    'chai', 'autocannon', 'clinic', 'insight', 'inquirer',
    'source-map', 'pngjs', 'bluebird',
    'electron-installer-common', 'rcedit', 'pe-library', 'cmake-js',
    'dir-compare', 'flora-colossus', 'galactus',
    'got', 'global-agent', 'global-dirs', 'roarr', 'serialize-error',
    'listr2', 'ora', 'log-symbols', 'log-update',
    'sudo-prompt', 'cross-zip', 'sumchecker',
  ];

  for (const scopeDir of scopeDirsToRemove) rmrf(path.join(nm, scopeDir));
  for (const pkgDir of packageDirsToRemove) rmrf(path.join(nm, pkgDir));
  rmGlob(nm, 'turbo');
}

function cleanNativeSources(nm) {
  console.log('Cleaning native module source/build leftovers...');
  rmrf(path.join(nm, 'audify', 'vendor'));
  rmrf(path.join(nm, 'audify', 'src'));
  rmrf(path.join(nm, 'audify', 'binding.gyp'));
  rmrf(path.join(nm, 'naudiodon2', 'src'));
  rmrf(path.join(nm, 'naudiodon2', 'binding.gyp'));
  rmrf(path.join(nm, 'node-datachannel', 'src'));
  rmrf(path.join(nm, 'node-datachannel', 'CMakeLists.txt'));
  rmrf(path.join(nm, 'node-datachannel', 'BULDING.md'));
  rmrf(path.join(nm, 'node-datachannel', 'rollup.config.mjs'));
  findAndRemoveDirs(nm, 'Debug');
  findAndRemoveDirs(nm, 'CMakeFiles');
  findAndRemoveDirs(nm, '.npm');
}

function cleanPackages(appRoot) {
  console.log('Cleaning workspace package sources...');
  findAndRemoveDirs(path.join(appRoot, 'packages'), 'node_modules');
  cleanDirKeep(path.join(appRoot, 'packages', 'web'), ['dist', 'package.json']);
  const distOnlyPackages = ['electron-main', 'electron-preload', 'server', 'core', 'contracts', 'builtin-plugins', 'plugin-api', 'rigctld-server'];
  for (const pkg of distOnlyPackages) {
    cleanDirKeep(path.join(appRoot, 'packages', pkg), ['dist', 'package.json', 'assets']);
  }
}

function cleanNonRuntimeFiles(nm) {
  console.log('Cleaning non-runtime files from node_modules...');
  for (const dirName of ['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github']) {
    findAndRemoveDirs(nm, dirName);
  }
  removeFilesByExt(nm, '.map');
  removeFilesByExt(nm, '.d.ts');
  removeFilesByExt(nm, '.d.ts.map');
  for (const prefix of ['README', 'CHANGELOG', 'HISTORY', '.eslintrc', 'tsconfig', '.prettierrc']) {
    removeFilesByPrefix(nm, prefix);
  }
}

function cleanPlatformPrebuilds(nm, platform, arch) {
  console.log(`Cleaning platform prebuilds for ${platform}-${arch}...`);
  const wsjtxPrebuilds = path.join(nm, 'wsjtx-lib', 'prebuilds');
  const hamlibPrebuilds = path.join(nm, 'hamlib', 'prebuilds');
  const serialportPrebuilds = path.join(nm, '@serialport', 'bindings-cpp', 'prebuilds');
  const onnxruntimePrebuilds = path.join(nm, 'onnxruntime-node', 'bin', 'napi-v6');

  if (platform === 'linux') {
    const removeArch = arch === 'arm64' ? 'linux-x64' : 'linux-arm64';
    const onnxKeepArch = arch === 'arm64' ? 'arm64' : 'x64';
    rmGlob(wsjtxPrebuilds, 'win32-');
    rmGlob(wsjtxPrebuilds, 'darwin-');
    rmrf(path.join(wsjtxPrebuilds, removeArch));
    rmGlob(hamlibPrebuilds, 'win32-');
    rmGlob(hamlibPrebuilds, 'darwin-');
    rmrf(path.join(hamlibPrebuilds, removeArch));
    rmGlob(serialportPrebuilds, 'win32-');
    rmGlob(serialportPrebuilds, 'darwin-');
    rmGlob(serialportPrebuilds, 'android-');
    rmrf(path.join(serialportPrebuilds, removeArch));
    rmrf(path.join(onnxruntimePrebuilds, 'darwin'));
    rmrf(path.join(onnxruntimePrebuilds, 'win32'));
    const linuxOnnx = path.join(onnxruntimePrebuilds, 'linux');
    if (fs.existsSync(linuxOnnx)) {
      for (const entry of fs.readdirSync(linuxOnnx)) if (entry !== onnxKeepArch) rmrf(path.join(linuxOnnx, entry));
    }
  }

  if (platform === 'darwin') {
    const removeArch = arch === 'arm64' ? 'darwin-x64' : 'darwin-arm64';
    const onnxKeepArch = arch === 'arm64' ? 'arm64' : 'x64';
    rmGlob(wsjtxPrebuilds, 'linux-');
    rmGlob(wsjtxPrebuilds, 'win32-');
    rmrf(path.join(wsjtxPrebuilds, removeArch));
    rmGlob(hamlibPrebuilds, 'linux-');
    rmGlob(hamlibPrebuilds, 'win32-');
    rmrf(path.join(hamlibPrebuilds, removeArch));
    rmGlob(serialportPrebuilds, 'linux-');
    rmGlob(serialportPrebuilds, 'win32-');
    rmGlob(serialportPrebuilds, 'android-');
    rmrf(path.join(onnxruntimePrebuilds, 'linux'));
    rmrf(path.join(onnxruntimePrebuilds, 'win32'));
    const darwinOnnx = path.join(onnxruntimePrebuilds, 'darwin');
    if (fs.existsSync(darwinOnnx)) {
      for (const entry of fs.readdirSync(darwinOnnx)) if (entry !== onnxKeepArch) rmrf(path.join(darwinOnnx, entry));
    }
  }

  if (platform === 'win32') {
    const onnxKeepArch = arch === 'arm64' ? 'arm64' : 'x64';
    rmGlob(wsjtxPrebuilds, 'linux-');
    rmGlob(wsjtxPrebuilds, 'darwin-');
    rmGlob(hamlibPrebuilds, 'linux-');
    rmGlob(hamlibPrebuilds, 'darwin-');
    rmGlob(serialportPrebuilds, 'linux-');
    rmGlob(serialportPrebuilds, 'darwin-');
    rmGlob(serialportPrebuilds, 'android-');
    rmrf(path.join(onnxruntimePrebuilds, 'linux'));
    rmrf(path.join(onnxruntimePrebuilds, 'darwin'));
    const winOnnx = path.join(onnxruntimePrebuilds, 'win32');
    if (fs.existsSync(winOnnx)) {
      for (const entry of fs.readdirSync(winOnnx)) if (entry !== onnxKeepArch) rmrf(path.join(winOnnx, entry));
    }
  }
}

function readMacosRpaths(runtimeFile) {
  const loadCommands = execSync(`otool -l ${shellQuote(runtimeFile)}`, { encoding: 'utf8' });
  return Array.from(loadCommands.matchAll(/^\s*path\s+(.+?)\s+\(offset\s+\d+\)$/gm), (match) => match[1]);
}

function fixMacosRuntimeRpaths(appRoot) {
  console.log('Fixing macOS native runtime RPATHs...');
  const nodeFiles = findFilesByExt(path.join(appRoot, 'node_modules'), '.node');
  const dylibFiles = findFilesByExt(path.join(appRoot, 'node_modules'), '.dylib');
  const runtimeFiles = [...nodeFiles, ...dylibFiles];
  let fixedCount = 0;
  for (const runtimeFile of runtimeFiles) {
    try {
      const rpaths = readMacosRpaths(runtimeFile);
      const seen = new Set();
      const duplicateRpaths = [];
      for (const rpath of rpaths) {
        if (seen.has(rpath) && !duplicateRpaths.includes(rpath)) {
          duplicateRpaths.push(rpath);
        }
        seen.add(rpath);
      }

      if (duplicateRpaths.length > 0) {
        console.log(`  Fixing duplicate RPATHs in ${path.basename(runtimeFile)}: ${duplicateRpaths.join(', ')}`);
        for (const rpath of duplicateRpaths) {
          const duplicateCount = rpaths.filter((p) => p === rpath).length;
          for (let i = 1; i < duplicateCount; i += 1) {
            execSync(`install_name_tool -delete_rpath ${shellQuote(rpath)} ${shellQuote(runtimeFile)}`, { stdio: 'pipe' });
          }
        }
        execSync(`codesign -f -s - ${shellQuote(runtimeFile)}`, { stdio: 'pipe' });
        fixedCount += 1;
      }
    } catch (error) {
      console.log(`  Skipping ${path.basename(runtimeFile)} (${error.message})`);
    }
  }
  console.log(`macOS RPATH fix complete (${fixedCount}/${runtimeFiles.length})`);
}

function signMacosBinaries(appRoot, resourcesDir, arch) {
  const identity = process.env.TX5DR_CODESIGN_IDENTITY_FULL || process.env.APPLE_IDENTITY;
  if (process.platform !== 'darwin' || !identity) return;
  const entitlementsPath = path.join(process.cwd(), 'build/entitlements.mac.plist');
  if (!fs.existsSync(entitlementsPath)) {
    throw new Error(`macOS entitlements file not found: ${entitlementsPath}`);
  }
  const nodeFiles = findFilesByExt(path.join(appRoot, 'node_modules'), '.node');
  const dylibFiles = findFilesByExt(path.join(appRoot, 'node_modules'), '.dylib');
  const runtimeFiles = [...dylibFiles, ...nodeFiles];
  console.log(`Signing macOS native runtime files (${runtimeFiles.length})...`);
  for (const runtimeFile of runtimeFiles) {
    execSync([
      'codesign',
      '--force',
      '--sign', shellQuote(identity),
      '--options runtime',
      '--entitlements', shellQuote(entitlementsPath),
      '--timestamp',
      shellQuote(runtimeFile),
    ].join(' '), { stdio: 'inherit' });
  }

  const nodeBinary = path.join(resourcesDir, 'bin', `darwin-${arch}`, 'node');
  if (fs.existsSync(nodeBinary)) {
    console.log(`Signing macOS portable node: ${nodeBinary}`);
    execSync([
      'codesign',
      '--force',
      '--sign', shellQuote(identity),
      '--options runtime',
      '--entitlements', shellQuote(entitlementsPath),
      '--timestamp',
      shellQuote(nodeBinary),
    ].join(' '), { stdio: 'inherit' });
  }
}

async function packageAfterCopy({ appRoot, resourcesDir, platform, arch }) {
  console.log(`Shared Electron package hook: ${platform}-${arch}`);
  console.log(`appRoot=${appRoot}`);
  console.log(`resourcesDir=${resourcesDir}`);
  const nm = path.join(appRoot, 'node_modules');

  try { pruneNodeModules(nm); } catch (error) { console.warn('node_modules prune warning:', error.message || error); }
  try { cleanNativeSources(nm); } catch (error) { console.warn('native cleanup warning:', error.message || error); }
  try { cleanPackages(appRoot); } catch (error) { console.warn('workspace cleanup warning:', error.message || error); }
  try { cleanNonRuntimeFiles(nm); } catch (error) { console.warn('non-runtime cleanup warning:', error.message || error); }
  try { cleanPlatformPrebuilds(nm, platform, arch); } catch (error) { console.warn('prebuild cleanup warning:', error.message || error); }

  if (platform === 'darwin') {
    try { fixMacosRuntimeRpaths(appRoot); } catch (error) { console.warn('macOS RPATH warning:', error.message || error); }
    signMacosBinaries(appRoot, resourcesDir, arch);
  }
}

module.exports = {
  getBuilderExtraResources,
  packageAfterCopy,
};
