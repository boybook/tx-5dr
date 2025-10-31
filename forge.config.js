import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

export default {
  packagerConfig: {
    name: 'TX-5DR',
    executableName: 'tx-5dr',
    icon: join(__dirname, 'packages', 'electron-main', 'assets', 'icon'),
    appBundleId: 'com.tx5dr.app',
    appCategoryType: 'public.app-category.utilities',
    asar: false,
    // 拷贝外置资源到 Contents/Resources 根目录（非 app/ 下）
    extraResource: [
      join(__dirname, 'resources', 'bin'),
      join(__dirname, 'resources', 'licenses'),
      join(__dirname, 'resources', 'README.txt')
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
      /^\/resources\/bin(\/|$)/
    ],
    // 禁用依赖裁剪，避免工作区（monorepo）被按根 package.json 误裁导致运行时缺包
    prune: false,
    darwinDarkModeSupport: true,
    // macOS 签名配置
    osxSign: (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' ? false : {
      // 使用显式的 identity (CI 从证书提取) 或自动查找 (本地)
      identity: process.env.APPLE_IDENTITY || undefined,
      hardenedRuntime: true,
      entitlements: 'build/entitlements.mac.plist',
      'entitlements-inherit': 'build/entitlements.mac.plist',
      'signature-flags': 'library',
      'gatekeeper-assess': false,
      verbose: true
    }),
    // macOS 公证配置
    osxNotarize: (process.env.CI && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ? {
      tool: 'notarytool',
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    } : false, // 本地开发默认不公证
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
      const { execSync } = await import('child_process');
      execSync('yarn build', { stdio: 'inherit' });
      console.log('✅ Build completed');
    },
    // 打包后的处理：精简 node_modules 与平台特定清理
    postPackage: async (forgeConfig, options) => {
      console.log('📦 Post-package hook executed');

      const { execSync } = await import('child_process');
      const { join } = await import('path');

      const packagingResult = options.outputPaths[0];
      // macOS: outputPaths[0] 指向目录（如 out/TX-5DR-darwin-arm64），需定位其中的 .app 目录
      let base = packagingResult;
      if (options.platform === 'darwin') {
        const fsMod = await import('fs');
        try {
          const entries = fsMod.readdirSync(packagingResult);
          const appDir = entries.find((n) => n.endsWith('.app'));
          if (appDir) base = join(packagingResult, appDir);
        } catch {}
      }
      // 不同平台 Resources 路径不同
      const resourcesDir = options.platform === 'darwin'
        ? join(base, 'Contents', 'Resources')
        : join(base, 'resources');
      const appRoot = join(resourcesDir, 'app');
      const nm = join(appRoot, 'node_modules');

      // 通用：删除明显的开发/打包期依赖，保留运行期依赖（如 fastify/hamlib/serialport/wsjtx-lib/naudiodon2 等）
      try {
        console.log('🧹 正在精简 node_modules...');
        const toRemove = [
          // Electron 打包相关 & 自身
          'electron', 'electron-winstaller', '@electron', '@electron-forge',
          // 构建工具/打包器
          'rollup', '@rollup', 'vite', '@vitejs', 'esbuild', '@esbuild', 'postject', 'sucrase',
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

      // 平台特定：清理跨架构预构建二进制，避免携带无用文件
      if (options.platform === 'linux') {
        try {
          console.log('🧹 [Linux] 清理跨架构与非Linux二进制文件...');
          const arch = options.arch || process.arch; // 'x64' | 'arm64'
          const keep = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';

          // wsjtx-lib 仅保留本平台预编译目录
          execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/win32-*" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/darwin-*" 2>/dev/null || true`, { stdio: 'inherit' });
          if (keep === 'linux-x64') {
            execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/linux-arm64" 2>/dev/null || true`, { stdio: 'inherit' });
          } else {
            execSync(`rm -rf "${appRoot}/node_modules/wsjtx-lib/prebuilds/linux-x64" 2>/dev/null || true`, { stdio: 'inherit' });
          }

          // naudiodon2: 删除Windows/MSVC目录与Windows二进制
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/msvc" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/bin" 2>/dev/null || true`, { stdio: 'inherit' });
          // 使用 -o 替代 \( \) 语法以兼容 dash shell
          execSync(`find "${appRoot}" -type f -name "*.dll" -delete 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`find "${appRoot}" -type f -name "*.exe" -delete 2>/dev/null || true`, { stdio: 'inherit' });

          // 删除非目标架构的 naudiodon2 预编译二进制文件（包括所有 ARM 变体）
          execSync(`rm -rf "${appRoot}"/node_modules/naudiodon2/portaudio/bin_arm* 2>/dev/null || true`, { stdio: 'inherit' });
          console.log('✅ [Linux] 清理完成');
        } catch (error) {
          console.warn('⚠️ [Linux] 清理跨架构文件时出现警告:', error.message);
        }
      }
      if (options.platform === 'darwin') {
        try {
          console.log('🧹 [macOS] 清理非本平台预构建...');
          // 仅保留 darwin-arm64 的 wsjtx-lib 预构建
          execSync(`find "${appRoot}" -path "*/wsjtx-lib/prebuilds/linux-*/*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`find "${appRoot}" -path "*/wsjtx-lib/prebuilds/win32-*/*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          // 清理 naudiodon2 Windows/MSVC 资源与 ARMHF 目录
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/msvc" 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`rm -rf "${appRoot}/node_modules/naudiodon2/portaudio/bin_arm*" 2>/dev/null || true`, { stdio: 'inherit' });
          console.log('✅ [macOS] 清理完成');
        } catch (error) {
          console.warn('⚠️ [macOS] 清理跨架构文件时出现警告:', error.message);
        }
      }

      // macOS: 签名外部 Node 二进制（electron-osx-sign 不会自动处理 extraResource）
      if (options.platform === 'darwin' && process.env.APPLE_IDENTITY) {
        try {
          console.log('🔐 [macOS] 签名外部 Node 二进制...');
          const path = await import('path');
          const fs = await import('fs');

          const entitlementsPath = path.join(process.cwd(), 'build/entitlements.mac.plist');
          const arch = options.arch || process.arch;
          const triplet = `darwin-${arch}`;
          const nodeBinaryPath = path.join(resourcesDir, 'bin', triplet, 'node');

          if (fs.existsSync(nodeBinaryPath)) {
            console.log(`  签名: ${nodeBinaryPath}`);
            execSync(
              `codesign --force --sign "${process.env.APPLE_IDENTITY}" --options runtime --entitlements "${entitlementsPath}" --timestamp "${nodeBinaryPath}"`,
              { stdio: 'inherit' }
            );
            console.log('✅ [macOS] Node 二进制签名完成');
          } else {
            console.log(`⚠️  [macOS] Node 二进制不存在: ${nodeBinaryPath}`);
          }
        } catch (error) {
          console.error('❌ [macOS] Node 二进制签名失败:', error.message);
          throw error; // 签名失败应该中止构建
        }
      } else if (options.platform === 'darwin') {
        console.log('✅ [macOS] electron-osx-sign 将自动处理所有原生模块的签名');
      }
    }
  }
}; 
