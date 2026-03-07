const { join, dirname } = require('path');

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
    // Windows Installers
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'TX5DR',
        authors: 'BG5DRB',
        description: 'TX-5DR Ham Radio FT8 Application',
        setupIcon: join(__dirname, 'packages', 'electron-main', 'assets', 'icon.ico'),
        iconUrl: 'https://raw.githubusercontent.com/boybook/tx-5dr/main/packages/electron-main/assets/icon.ico'
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
      // join already imported at top level

      // buildPath 直接指向 app 内容根目录
      const appRoot = buildPath;
      const nm = join(appRoot, 'node_modules');

      // 通用：删除明显的开发/打包期依赖，保留运行期依赖（如 fastify/hamlib/serialport/wsjtx-lib/naudiodon2 等）
      try {
        console.log('🧹 正在精简 node_modules...');
        const toRemove = [
          // Electron 打包相关 & 自身
          'electron', 'electron-winstaller', '@electron', '@electron-forge',
          // 构建工具/打包器
          'rollup', '@rollup', 'vite', '@vitejs', 'esbuild', '@esbuild', 'postject', 'sucrase',
          'appdmg', 'jiti', '@swc',  // DMG 制作和编译工具
          // 代码质量/类型
          'typescript', '@types', 'eslint', '@eslint', '@eslint-community', '@typescript-eslint', 'prettier',
          // UI/前端开发依赖（运行时使用的是打包后的 web/dist，不需要包体）
          '@heroui', '@heroicons', '@fortawesome', 'caniuse-lite', 'tailwindcss', 'tailwind-merge', 'tailwind-variants',
          '@react-aria', '@react-stately', '@react-types', '@formatjs', 'react', 'react-dom', 'framer-motion', 'rxjs', '@babel',
          // monorepo/开发辅助
          /^turbo.*/,
          // 其他只在构建期使用
          'png-to-ico', 'vitest', '@vitest', 'tsx', 'node-gyp', 'electron-installer-redhat', 'electron-installer-debian', 'segfault-handler'
        ];

        for (const item of toRemove) {
          const pattern = typeof item === 'string' ? item : item.source; // 日志友好
          try {
            const cmd = typeof item === 'string'
              ? `rm -rf "${join(nm, item)}"`
              : `ls "${nm}" | grep -E "${item.source}" | xargs -I{} rm -rf "${join(nm, '{}')}"`;
            execSync(cmd, { stdio: 'inherit', env: process.env });
          } catch {
            // ignore
          }
        }
        console.log('✅ node_modules 精简完成');
      } catch (err) {
        console.warn('⚠️ 精简 node_modules 遇到问题：', (err && err.message) || err);
      }

      // 清理 packages 子目录的 node_modules（最大的体积占用）
      try {
        console.log('🧹 正在清理 packages/*/node_modules...');
        execSync(`find "${appRoot}/packages" -name "node_modules" -type d -prune -exec rm -rf {} + 2>/dev/null || true`, { stdio: 'inherit' });
        console.log('✅ packages/*/node_modules 清理完成');
      } catch (err) {
        console.warn('⚠️ 清理 packages/*/node_modules 遇到问题：', (err && err.message) || err);
      }

      // 清理 packages/web 的源码，只保留 dist 和 package.json
      try {
        console.log('🧹 正在清理 packages/web 源码...');
        const webDir = join(appRoot, 'packages', 'web');
        // 删除除了 dist 和 package.json 之外的所有内容
        execSync(`cd "${webDir}" && find . -mindepth 1 -maxdepth 1 ! -name "dist" ! -name "package.json" -exec rm -rf {} + 2>/dev/null || true`, { stdio: 'inherit' });
        console.log('✅ packages/web 源码清理完成');
      } catch (err) {
        console.warn('⚠️ 清理 packages/web 源码遇到问题：', (err && err.message) || err);
      }

      // 清理其他 packages 的非必要文件（保留 dist, package.json, node 二进制）
      try {
        console.log('🧹 正在清理其他 packages 的源码...');
        const packagesDir = join(appRoot, 'packages');
        const packagesToClean = ['electron-main', 'electron-preload', 'server', 'core', 'contracts'];

        for (const pkg of packagesToClean) {
          const pkgDir = join(packagesDir, pkg);
          // 保留 dist, package.json, assets (仅 electron-main 需要), 删除其他内容
          execSync(`cd "${pkgDir}" && find . -mindepth 1 -maxdepth 1 ! -name "dist" ! -name "package.json" ! -name "assets" -exec rm -rf {} + 2>/dev/null || true`, { stdio: 'inherit' });
        }
        console.log('✅ 其他 packages 源码清理完成');
      } catch (err) {
        console.warn('⚠️ 清理其他 packages 源码遇到问题：', (err && err.message) || err);
      }

      // 平台特定：清理跨架构预构建二进制，避免携带无用文件
      if (platform === 'linux') {
        try {
          console.log('🧹 [Linux] 清理跨架构与非Linux二进制文件...');
          const keep = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';

          // wsjtx-lib 仅保留本平台预编译目录
          execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/win32-*" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/darwin-*" 2>/dev/null || true`, { stdio: 'inherit' });
          if (keep === 'linux-x64') {
            execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/linux-arm64" 2>/dev/null || true`, { stdio: 'inherit' });
          } else {
            execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/linux-x64" 2>/dev/null || true`, { stdio: 'inherit' });
          }

          // hamlib 仅保留本平台预编译目录
          execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/win32-*" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/darwin-*" 2>/dev/null || true`, { stdio: 'inherit' });
          if (keep === 'linux-x64') {
            execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/linux-arm64" 2>/dev/null || true`, { stdio: 'inherit' });
          } else {
            execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/linux-x64" 2>/dev/null || true`, { stdio: 'inherit' });
          }

          // naudiodon2: 删除Windows/MSVC目录与Windows二进制
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/msvc" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/bin" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`find "${appRoot}" -type f -name "*.dll" -delete 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`find "${appRoot}" -type f -name "*.exe" -delete 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}"/node_modules/naudiodon2/portaudio/bin_arm* 2>/dev/null || true`, { stdio: 'inherit' });
          console.log('✅ [Linux] 清理完成');
        } catch (error) {
          console.warn('⚠️ [Linux] 清理跨架构文件时出现警告:', error.message);
        }
      }
      if (platform === 'darwin') {
        try {
          console.log(`🧹 [macOS] 清理非本平台预构建（保留 darwin-${arch}）...`);

          // wsjtx-lib: 清理其他平台和架构
          execSync(`find "${appRoot}" -path "*/wsjtx-lib/prebuilds/linux-*/*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`find "${appRoot}" -path "*/wsjtx-lib/prebuilds/win32-*/*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          // 清理其他 macOS 架构
          if (arch === 'arm64') {
            execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/darwin-x64" 2>/dev/null || true`, { stdio: 'inherit' });
          } else {
            execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/darwin-arm64" 2>/dev/null || true`, { stdio: 'inherit' });
          }

          // hamlib: 清理其他平台和架构
          execSync(`find "${appRoot}" -path "*/hamlib/prebuilds/linux-*/*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`find "${appRoot}" -path "*/hamlib/prebuilds/win32-*/*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          // 清理其他 macOS 架构
          if (arch === 'arm64') {
            execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/darwin-x64" 2>/dev/null || true`, { stdio: 'inherit' });
          } else {
            execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/darwin-arm64" 2>/dev/null || true`, { stdio: 'inherit' });
          }

          // 清理 naudiodon2 Windows/MSVC 资源与 ARMHF 目录
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/msvc" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/bin_arm*" 2>/dev/null || true`, { stdio: 'inherit' });
          console.log('✅ [macOS] 清理完成');
        } catch (error) {
          console.warn('⚠️ [macOS] 清理跨架构文件时出现警告:', error.message);
        }
      }

      if (platform === 'win32') {
        try {
          console.log(`🧹 [Windows] 清理非本平台预构建（保留 win32-${arch}）...`);

          // wsjtx-lib: 清理其他平台
          execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/linux-*" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/darwin-*" 2>/dev/null || true`, { stdio: 'inherit' });

          // hamlib: 清理其他平台
          execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/linux-*" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/hamlib/prebuilds/darwin-*" 2>/dev/null || true`, { stdio: 'inherit' });

          // naudiodon2: 清理 Linux/macOS 相关文件
          execSync(`rm -rf "${appRoot}"/node_modules/naudiodon2/portaudio/bin_arm* 2>/dev/null || true`, { stdio: 'inherit' });

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
          const { execSync: exec } = require('child_process');

          // 查找所有 .node 文件
          const findCmd = `find "${appRoot}/node_modules" -name "*.node" -type f`;
          let nodeFiles = [];
          try {
            const output = exec(findCmd, { encoding: 'utf8' });
            nodeFiles = output.trim().split('\n').filter(Boolean);
          } catch (e) {
            console.log('  未找到 .node 文件');
          }

          let fixedCount = 0;
          for (const nodeFile of nodeFiles) {
            try {
              // 检查是否有重复的 @loader_path/ RPATH
              const rpaths = exec(
                `otool -l "${nodeFile}" | grep -A 2 LC_RPATH | grep path | awk '{print $2}'`,
                { encoding: 'utf8' }
              ).trim().split('\n').filter(Boolean);

              // 统计 @loader_path/ 出现次数
              const loaderPathCount = rpaths.filter(p => p === '@loader_path/').length;

              if (loaderPathCount > 1) {
                console.log(`  修复: ${path.basename(nodeFile)} (发现 ${loaderPathCount} 个重复的 @loader_path/)`);

                // 删除重复的 @loader_path/ (保留第一个，删除其余)
                for (let i = 1; i < loaderPathCount; i++) {
                  exec(`install_name_tool -delete_rpath "@loader_path/" "${nodeFile}"`, { stdio: 'pipe' });
                }

                // adhoc 重新签名
                exec(`codesign -f -s - "${nodeFile}"`, { stdio: 'pipe' });
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
          const fs = require('fs');

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
