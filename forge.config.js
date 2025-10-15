import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default {
  packagerConfig: {
    name: 'TX-5DR',
    executableName: 'tx-5dr',
    icon: './packages/electron-main/assets/icon',
    appBundleId: 'com.tx5dr.app',
    appCategoryType: 'public.app-category.utilities',
    asar: false,
    // 拷贝外置资源到 Contents/Resources 根目录（非 app/ 下）
    extraResource: [
      './resources/bin',
      './resources/licenses',
      './resources/README.txt'
    ],
    // 动态设置架构（用于CI/CD环境）
    arch: process.env.ARCH || undefined,
    platform: process.env.PLATFORM || undefined,
    // 简化 ignore 规则，只忽略最基本的开发文件
    ignore: [
      /^\/\.git/,
      /^\/\.turbo/,
      /^\/turbo\.json$/,
      /^\/forge\.config\.js$/,
      /^\/yarn\.lock$/,
      /^\/\.yarn/,
      /^\/\.pnp/,
      /^\/out$/,   // 忽略输出目录
    ],
    // 使用默认的依赖裁剪
    prune: true,
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
        setupIcon: './packages/electron-main/assets/icon.ico',
                  iconUrl: 'https://raw.githubusercontent.com/boybook/tx-5dr/main/packages/electron-main/assets/icon.ico'
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
          icon: './packages/electron-main/assets/icon.png',
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
          icon: './packages/electron-main/assets/icon.png',
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
    // 打包后的处理（保留 Linux 清理）
    postPackage: async (forgeConfig, options) => {
      console.log('📦 Post-package hook executed');
      
      // 在 Linux 平台上，清理可能导致 RPM 打包失败的跨架构文件
      if (options.platform === 'linux') {
        const { execSync } = await import('child_process');
        const { join } = await import('path');
        
        console.log('🧹 [Linux] 清理跨架构二进制文件...');
        
        const packagingResult = options.outputPaths[0];
        const resourcesPath = join(packagingResult, 'resources', 'app');
        
        try {
          // 清理 wsjtx-lib 的 ARM64 预构建文件
          execSync(`find "${resourcesPath}" -path "*/wsjtx-lib/prebuilds/linux-arm64*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          
          // 清理 naudiodon2 的 ARM 预构建文件  
          execSync(`find "${resourcesPath}" -path "*/naudiodon2/portaudio/bin_arm*" -type f -delete 2>/dev/null || true`, { stdio: 'inherit' });
          
          console.log('✅ [Linux] 跨架构文件清理完成');
        } catch (error) {
          console.warn('⚠️ [Linux] 清理跨架构文件时出现警告:', error.message);
        }
      }
    }
  }
}; 
