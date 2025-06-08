import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default {
  packagerConfig: {
    name: 'TX-5DR',
    executableName: 'tx-5dr',
    icon: './assets/icon',
    appBundleId: 'com.tx5dr.app',
    appCategoryType: 'public.app-category.utilities',
    asar: true,
    // 动态设置架构（用于CI/CD环境）
    arch: process.env.ARCH || undefined,
    platform: process.env.PLATFORM || undefined,
    // 忽略开发依赖和源代码
    ignore: [
      /^\/\.git/,
      /^\/node_modules\/(?!(@tx5dr|electron))/,
      /^\/packages\/[^/]+\/src/,
      /^\/packages\/[^/]+\/test/,
      /^\/packages\/[^/]+\/\.turbo/,
      /^\/\.turbo/,
      /^\/turbo\.json$/,
      /^\/forge\.config\.js$/,
      /^\/yarn\.lock$/,
      /^\/\.yarn/,
      /^\/\.pnp/,
      /^\/README\.md$/,
      /^\/docs/,
      /^\/\.github/,
      /^\/\.vscode/,
      /^\/\.eslintrc/,
      /^\/\.prettierrc/,
      /^\/tsconfig\.json$/,
      /^\/dist$/,  // 忽略根目录的 dist
      /^\/out$/,   // 忽略输出目录
      /^\/README-BUILD\.md$/,
    ],
    // 额外的资源文件 - 暂时注释掉，避免冲突
    // extraResource: [
    //   './packages/web/dist',
    //   './packages/server/dist',
    //   './packages/core/dist',
    //   './packages/contracts/dist',
    //   './packages/electron-preload/dist'
    // ],
    darwinDarkModeSupport: true,
    // 平台特定配置
    osxSign: false, // 暂时禁用签名
    osxNotarize: false, // 暂时禁用公证
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
        setupIcon: './assets/icon.ico',
        iconUrl: 'https://raw.githubusercontent.com/your-repo/tx-5dr/main/assets/icon.ico'
      }
    },
    // macOS Packages
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
          icon: './assets/icon.png',
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
          icon: './assets/icon.png',
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
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {}
    }
  ],
  hooks: {
    // 打包前构建所有项目
    generateAssets: async () => {
      console.log('🔨 Building all packages...');
      const { execSync } = await import('child_process');
      execSync('yarn build', { stdio: 'inherit' });
      console.log('✅ Build completed');
    },
    // 打包后的处理
    postPackage: async (forgeConfig, options) => {
      console.log('📦 Post-package hook executed');
      // 可以在这里添加额外的处理逻辑
    }
  }
}; 