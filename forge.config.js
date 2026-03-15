const { join, dirname, basename } = require('path');
const fs = require('fs');

// ========== 跨平台文件操作工具 ==========

/** 递归删除目录或文件（跨平台，静默忽略不存在的路径） */
function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** 删除目录下匹配 glob 前缀的子目录（如 'linux-*' 匹配 'linux-x64', 'linux-arm64'） */
function rmGlob(parentDir, prefix) {
  try {
    if (!fs.existsSync(parentDir)) return;
    for (const entry of fs.readdirSync(parentDir)) {
      if (entry.startsWith(prefix)) {
        rmrf(join(parentDir, entry));
      }
    }
  } catch {
    // ignore
  }
}

/** 删除目录下除了 keepNames 以外的所有一级子项 */
function cleanDirKeep(dir, keepNames) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (!keepNames.includes(entry)) {
        rmrf(join(dir, entry));
      }
    }
  } catch {
    // ignore
  }
}

/** 递归查找指定目录下名为 targetName 的目录并删除 */
function findAndRemoveDirs(rootDir, targetName) {
  try {
    if (!fs.existsSync(rootDir)) return;
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      const fullPath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === targetName) {
          rmrf(fullPath);
        } else {
          findAndRemoveDirs(fullPath, targetName);
        }
      }
    }
  } catch {
    // ignore
  }
}

/** 递归查找所有匹配扩展名的文件 */
function findFilesByExt(dir, ext) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
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

// ========== DEBUG: macOS Signing Config ==========
if (process.platform === 'darwin') {
  console.log('========== DEBUG: macOS Signing Config ==========');
  console.log('Platform:', process.platform);
  console.log('APPLE_IDENTITY:', process.env.APPLE_IDENTITY);
  console.log('CI:', process.env.CI);
  console.log('CSC_IDENTITY_AUTO_DISCOVERY:', process.env.CSC_IDENTITY_AUTO_DISCOVERY);
  console.log('All APPLE_* vars:', Object.keys(process.env).filter(k => k.startsWith('APPLE')));
  console.log('=================================================');
}

module.exports = {
  packagerConfig: {
    name: 'TX-5DR',
    executableName: 'tx-5dr',
    icon: join(__dirname, 'packages', 'electron-main', 'assets', 'AppIcon'),
    // macOS 26+ 使用 CFBundleIconName 引用 Assets.car 中的图标
    extendInfo: {
      CFBundleIconName: 'AppIcon',
      CFBundleIconFile: 'AppIcon.icns'
    },
    appBundleId: 'com.tx5dr.app',
    appCategoryType: 'public.app-category.utilities',
    asar: false,
    // 拷贝外置资源到 Contents/Resources 根目录（非 app/ 下）
    extraResource: [
      join(__dirname, 'resources', 'bin'),
      join(__dirname, 'resources', 'licenses'),
      join(__dirname, 'resources', 'README.txt'),
      join(__dirname, 'packages', 'electron-main', 'assets'),
      // macOS 26+ Assets.car 和 AppIcon.icns 必须在 Resources 根目录
      join(__dirname, 'packages', 'electron-main', 'assets', 'Assets.car'),
      join(__dirname, 'packages', 'electron-main', 'assets', 'AppIcon.icns')
    ],
    // 动态设置架构（用于CI/CD环境）
    arch: process.env.ARCH || undefined,
    platform: process.env.PLATFORM || undefined,
    // 精简打包产物：忽略开发产物、缓存、临时 Node 下载包，以及 app 内重复的 resources/bin
    ignore: [
      /^\/\.git/,
      /^\/\.turbo/,
      /^\/turbo\.json$/,
      /^\/forge\.config\.js$/,
      /^\/yarn\.lock$/,
      /^\/\.yarn/,
      /^\/\.pnp/,
      /^\/out$/,                     // 忽略输出目录
      /^\/\.electron-cache$/,       // Electron 缓存
      /^\/\.electron-builder-cache$/,
      /^\/\.npm$/,                  // npm 缓存（若存在）
      // 忽略临时下载/解压的 Node 包（例如 node-v22.15.1-darwin-arm64 及其 .tar.xz/.zip 文件）
      /^\/node-v[0-9]+\.[0-9]+\.[0-9]+[\w.-]*$/,                                // 解压目录
      /^\/node-v[0-9]+\.[0-9]+\.[0-9]+[\w.-]*\.(?:tar\.xz|tar\.gz|zip)$/,   // 压缩包
      // 避免把 resources/bin 作为应用源码打进 Contents/Resources/app/resources/bin
      /^\/resources\/bin(\/|$)/,
      // 文档和开发相关文件
      /^\/docker(\/|$)/,            // Docker 相关目录
      /^\/docs(\/|$)/,              // 文档目录
      /^\/scripts(\/|$)/,           // 脚本目录
      /^\/data(\/|$)/,              // 数据目录
      /^\/Dockerfile$/,
      /^\/docker-compose\.yml$/,
      /^\/\.dockerignore$/,
      /^\/CLAUDE\.md$/,
      /^\/README\.md$/,
      /^\/CertificateSigningRequest\.certSigningRequest$/,
      /^\/\.github(\/|$)/           // GitHub workflows
    ],
    // 禁用依赖裁剪，避免工作区（monorepo）被按根 package.json 误裁导致运行时缺包
    prune: false,
    darwinDarkModeSupport: true,
    // macOS 签名配置（仅在有证书时启用）
    osxSign: process.env.APPLE_IDENTITY ? {
      // 使用显式的 identity (CI 从证书提取) 或自动查找 (本地)
      identity: process.env.APPLE_IDENTITY,
      hardenedRuntime: true,
      entitlements: 'build/entitlements.mac.plist',
      'entitlements-inherit': 'build/entitlements.mac.plist',
      'signature-flags': 'library',
      'gatekeeper-assess': false,
      verbose: true
    } : undefined,
    // macOS 公证配置（仅在有凭证时启用）
    osxNotarize: process.env.APPLE_ID ? {
      tool: 'notarytool',
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    } : undefined,
    // Windows 特定配置
    win32metadata: {
      CompanyName: 'TX-5DR Team',
      FileDescription: 'TX-5DR Ham Radio FT8 Application',
      ProductName: 'TX-5DR',
      InternalName: 'tx-5dr'
    }
  },
  rebuildConfig: {},
  makers: [
    // Windows MSI Installer (WiX)
    {
      name: '@electron-forge/maker-wix',
      platforms: ['win32'],
      config: {
        name: 'TX-5DR',
        manufacturer: 'TX-5DR Team',
        description: 'TX-5DR Ham Radio FT8 Application',
        icon: join(__dirname, 'packages', 'electron-main', 'assets', 'icon.ico'),
        ui: {
          chooseDirectory: true  // 用户可选择安装目录
        },
        programFilesFolderName: 'TX-5DR',
        shortcutFolderName: 'TX-5DR',
        shortcutName: 'TX-5DR',
        appUserModelId: 'com.tx5dr.app',
        // MSI 升级链路标识 - 发布后永不更改
        upgradeCode: '77C3C854-49C2-4650-A366-D4CD08EDDF96'
      }
    },
    // macOS Packages - DMG 安装包
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
        overwrite: true
      }
    },
    // macOS Packages - ZIP 便携版
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: {}
    },
    // Linux Packages (use basic ones that work reliably)
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          maintainer: 'BG5DRB <bg5drb@example.com>',
          homepage: 'https://tx5dr.com',
          icon: join(__dirname, 'packages', 'electron-main', 'assets', 'icon.png'),
          categories: ['Utility', 'AudioVideo'],
          description: 'TX-5DR Ham Radio FT8 Application - Digital mode software for amateur radio',
          genericName: 'Ham Radio Application'
        }
      }
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          homepage: 'https://tx5dr.com',
          icon: join(__dirname, 'packages', 'electron-main', 'assets', 'icon.png'),
          categories: ['Utility', 'AudioVideo'],
          description: 'TX-5DR Ham Radio FT8 Application - Digital mode software for amateur radio',
          genericName: 'Ham Radio Application',
          license: 'MIT'
        }
      }
    },
    // Cross-platform ZIP fallback
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux', 'win32'],
      config: {}
    }
  ],
  plugins: [
    // {
    //   name: '@electron-forge/plugin-auto-unpack-natives',
    //   config: {}
    // }
  ],
  hooks: {
    // 打包前构建所有项目
    generateAssets: async () => {
      console.log('🔨 Building all packages...');
      const { execSync } = require('child_process');
      execSync('yarn build', { stdio: 'inherit' });
      console.log('✅ Build completed');
    },
    // 签名前的文件清理：在签名之前精简 node_modules 与平台特定清理
    packageAfterCopy: async (forgeConfig, buildPath, electronVersion, platform, arch) => {
      console.log('📦 Package-after-copy hook executed (before signing)');

      const { execSync } = require('child_process');

      // buildPath 直接指向 app 内容根目录
      const appRoot = buildPath;
      const nm = join(appRoot, 'node_modules');

      // ====== 通用：删除明显的开发/打包期依赖 ======
      try {
        console.log('🧹 正在精简 node_modules...');
        const toRemoveExact = [
          // Electron 打包相关 & 自身
          'electron', 'electron-winstaller', '@electron', '@electron-forge',
          // 构建工具/打包器
          'rollup', '@rollup', 'vite', '@vitejs', 'esbuild', '@esbuild', 'postject', 'sucrase',
          'appdmg', 'jiti', '@swc',
          // 代码质量/类型
          'typescript', '@types', 'eslint', '@eslint', '@eslint-community', '@typescript-eslint', 'prettier',
          // UI/前端开发依赖（运行时使用的是打包后的 web/dist）
          '@heroui', '@heroicons', '@fortawesome', 'caniuse-lite', 'tailwindcss', 'tailwind-merge', 'tailwind-variants',
          '@react-aria', '@react-stately', '@react-types', '@formatjs', 'react', 'react-dom', 'framer-motion', 'rxjs', '@babel',
          // 其他只在构建期使用
          'png-to-ico', 'vitest', '@vitest', 'tsx', 'node-gyp', 'electron-installer-redhat', 'electron-installer-debian', 'segfault-handler'
        ];

        // 删除精确匹配的包
        for (const pkg of toRemoveExact) {
          rmrf(join(nm, pkg));
        }

        // 删除 turbo* 开头的包
        rmGlob(nm, 'turbo');

        console.log('✅ node_modules 精简完成');
      } catch (err) {
        console.warn('⚠️ 精简 node_modules 遇到问题：', (err && err.message) || err);
      }

      // ====== 清理 packages 子目录的 node_modules ======
      try {
        console.log('🧹 正在清理 packages/*/node_modules...');
        findAndRemoveDirs(join(appRoot, 'packages'), 'node_modules');
        console.log('✅ packages/*/node_modules 清理完成');
      } catch (err) {
        console.warn('⚠️ 清理 packages/*/node_modules 遇到问题：', (err && err.message) || err);
      }

      // ====== 清理 packages/web 的源码，只保留 dist 和 package.json ======
      try {
        console.log('🧹 正在清理 packages/web 源码...');
        cleanDirKeep(join(appRoot, 'packages', 'web'), ['dist', 'package.json']);
        console.log('✅ packages/web 源码清理完成');
      } catch (err) {
        console.warn('⚠️ 清理 packages/web 源码遇到问题：', (err && err.message) || err);
      }

      // ====== 清理其他 packages 的非必要文件 ======
      try {
        console.log('🧹 正在清理其他 packages 的源码...');
        const packagesToClean = ['electron-main', 'electron-preload', 'server', 'core', 'contracts'];
        for (const pkg of packagesToClean) {
          cleanDirKeep(join(appRoot, 'packages', pkg), ['dist', 'package.json', 'assets']);
        }
        console.log('✅ 其他 packages 源码清理完成');
      } catch (err) {
        console.warn('⚠️ 清理其他 packages 源码遇到问题：', (err && err.message) || err);
      }

      // ====== 平台特定：清理跨架构预构建二进制 ======
      const wsjtxPrebuilds = join(nm, 'wsjtx-lib', 'prebuilds');
      const hamlibPrebuilds = join(nm, 'hamlib', 'prebuilds');

      if (platform === 'linux') {
        try {
          console.log('🧹 [Linux] 清理跨架构与非Linux二进制文件...');
          const keepArch = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
          const removeArch = arch === 'arm64' ? 'linux-x64' : 'linux-arm64';

          // wsjtx-lib: 仅保留本平台
          rmGlob(wsjtxPrebuilds, 'win32-');
          rmGlob(wsjtxPrebuilds, 'darwin-');
          rmrf(join(wsjtxPrebuilds, removeArch));

          // hamlib: 仅保留本平台
          rmGlob(hamlibPrebuilds, 'win32-');
          rmGlob(hamlibPrebuilds, 'darwin-');
          rmrf(join(hamlibPrebuilds, removeArch));

          console.log('✅ [Linux] 清理完成');
        } catch (error) {
          console.warn('⚠️ [Linux] 清理跨架构文件时出现警告:', error.message);
        }
      }

      if (platform === 'darwin') {
        try {
          console.log(`🧹 [macOS] 清理非本平台预构建（保留 darwin-${arch}）...`);
          const removeArch = arch === 'arm64' ? 'darwin-x64' : 'darwin-arm64';

          // wsjtx-lib: 清理其他平台和架构
          rmGlob(wsjtxPrebuilds, 'linux-');
          rmGlob(wsjtxPrebuilds, 'win32-');
          rmrf(join(wsjtxPrebuilds, removeArch));

          // hamlib: 清理其他平台和架构
          rmGlob(hamlibPrebuilds, 'linux-');
          rmGlob(hamlibPrebuilds, 'win32-');
          rmrf(join(hamlibPrebuilds, removeArch));

          console.log('✅ [macOS] 清理完成');
        } catch (error) {
          console.warn('⚠️ [macOS] 清理跨架构文件时出现警告:', error.message);
        }
      }

      if (platform === 'win32') {
        try {
          console.log(`🧹 [Windows] 清理非本平台预构建（保留 win32-${arch}）...`);

          // wsjtx-lib: 清理其他平台
          rmGlob(wsjtxPrebuilds, 'linux-');
          rmGlob(wsjtxPrebuilds, 'darwin-');

          // hamlib: 清理其他平台
          rmGlob(hamlibPrebuilds, 'linux-');
          rmGlob(hamlibPrebuilds, 'darwin-');

          console.log('✅ [Windows] 清理完成');
        } catch (error) {
          console.warn('⚠️ [Windows] 清理跨架构文件时出现警告:', error.message);
        }
      }

      // macOS: 修复 native 模块的重复 RPATH 问题 (必须在签名之前)
      if (platform === 'darwin') {
        try {
          console.log('🔧 [macOS] 修复 native 模块 RPATH...');
          const path = require('path');

          // 查找所有 .node 文件（使用跨平台方法）
          const nodeFiles = findFilesByExt(join(appRoot, 'node_modules'), '.node');

          let fixedCount = 0;
          for (const nodeFile of nodeFiles) {
            try {
              // 检查是否有重复的 @loader_path/ RPATH
              const rpaths = execSync(
                `otool -l "${nodeFile}" | grep -A 2 LC_RPATH | grep path | awk '{print $2}'`,
                { encoding: 'utf8' }
              ).trim().split('\n').filter(Boolean);

              // 统计 @loader_path/ 出现次数
              const loaderPathCount = rpaths.filter(p => p === '@loader_path/').length;

              if (loaderPathCount > 1) {
                console.log(`  修复: ${path.basename(nodeFile)} (发现 ${loaderPathCount} 个重复的 @loader_path/)`);

                // 删除重复的 @loader_path/ (保留第一个，删除其余)
                for (let i = 1; i < loaderPathCount; i++) {
                  execSync(`install_name_tool -delete_rpath "@loader_path/" "${nodeFile}"`, { stdio: 'pipe' });
                }

                // adhoc 重新签名
                execSync(`codesign -f -s - "${nodeFile}"`, { stdio: 'pipe' });
                fixedCount++;
              }
            } catch (e) {
              // 单个文件失败不影响其他文件
              console.log(`  ⚠️  跳过: ${path.basename(nodeFile)} (${e.message})`);
            }
          }

          console.log(`✅ [macOS] RPATH 修复完成 (处理 ${fixedCount}/${nodeFiles.length} 个文件)`);
        } catch (error) {
          console.warn('⚠️ [macOS] RPATH 修复遇到问题:', error.message);
        }
      }

      // macOS: 签名外部 Node 二进制 (必须在 electron-osx-sign 之前)
      if (platform === 'darwin' && process.env.APPLE_IDENTITY) {
        try {
          console.log('🔐 [macOS] 签名外部 Node 二进制 (签名前)...');
          const path = require('path');

          const entitlementsPath = path.join(process.cwd(), 'build/entitlements.mac.plist');
          const triplet = `darwin-${arch}`;
          // buildPath 指向 app 内容根目录, 外部资源在 Resources/ 下
          const nodeBinaryPath = path.join(buildPath, 'Resources', 'bin', triplet, 'node');

          if (fs.existsSync(nodeBinaryPath)) {
            console.log(`  签名: ${nodeBinaryPath}`);
            execSync(
              `codesign --force --sign "${process.env.APPLE_IDENTITY}" --options runtime --entitlements "${entitlementsPath}" --timestamp "${nodeBinaryPath}"`,
              { stdio: 'inherit' }
            );
            console.log('✅ [macOS] Node 二进制签名完成 (签名前)');
          } else {
            console.log(`⚠️  [macOS] Node 二进制不存在: ${nodeBinaryPath}`);
          }
        } catch (error) {
          console.error('❌ [macOS] Node 二进制签名失败:', error.message);
          throw error; // 签名失败应该中止构建
        }
      }
    },
    // 打包后的处理：用于验证和日志输出
    postPackage: async (forgeConfig, options) => {
      console.log('📦 Post-package hook executed (after signing)');

      // macOS: 所有签名已在 packageAfterCopy hook 中完成
      if (options.platform === 'darwin') {
        console.log('✅ [macOS] 所有签名已在 packageAfterCopy hook 中完成');
      }
    }
  }
};
