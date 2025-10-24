const { execSync } = require('child_process');
const path = require('path');

/**
 * electron-builder afterPack hook
 * 打包后精简 node_modules 和清理跨平台文件
 */
exports.default = async function afterPack(context) {
  console.log('📦 After-pack hook executed');

  const { appOutDir, packager } = context;
  const platform = packager.platform.name; // 'darwin', 'linux', 'win32'
  const arch = packager.arch; // Arch.x64, Arch.arm64

  // 确定 app 根目录路径
  let appRoot;
  if (platform === 'darwin') {
    appRoot = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app');
  } else if (platform === 'win32') {
    appRoot = path.join(appOutDir, 'resources', 'app');
  } else {
    appRoot = path.join(appOutDir, 'resources', 'app');
  }

  const nm = path.join(appRoot, 'node_modules');

  // 通用：删除开发/打包期依赖
  try {
    console.log('🧹 正在精简 node_modules...');
    const toRemove = [
      // Electron 打包相关
      'electron',
      'electron-winstaller',
      '@electron',
      '@electron-forge',
      'electron-builder',
      '@electron/rebuild',
      // 构建工具/打包器
      'rollup',
      '@rollup',
      'vite',
      '@vitejs',
      'esbuild',
      '@esbuild',
      'postject',
      'sucrase',
      // 代码质量/类型
      'typescript',
      '@types',
      'eslint',
      '@eslint',
      '@eslint-community',
      '@typescript-eslint',
      'prettier',
      // UI/前端开发依赖（运行时使用打包后的 web/dist）
      '@heroui',
      '@heroicons',
      '@fortawesome',
      'caniuse-lite',
      'tailwindcss',
      'tailwind-merge',
      'tailwind-variants',
      '@react-aria',
      '@react-stately',
      '@react-types',
      '@formatjs',
      'react',
      'react-dom',
      'framer-motion',
      'rxjs',
      '@babel',
      // monorepo/开发辅助
      'turbo',
      // 其他构建期依赖
      'png-to-ico',
      'vitest',
      '@vitest',
      'tsx',
      'node-gyp',
      'electron-installer-redhat',
      'electron-installer-debian',
      'segfault-handler',
    ];

    for (const item of toRemove) {
      try {
        const targetPath = path.join(nm, item);
        execSync(`rm -rf "${targetPath}"`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
    }
    console.log('✅ node_modules 精简完成');
  } catch (err) {
    console.warn('⚠️ 精简 node_modules 遇到问题：', err?.message || err);
  }

  // 平台特定：清理跨架构预构建二进制
  if (platform === 'linux') {
    try {
      console.log('🧹 [Linux] 清理跨架构与非Linux二进制文件...');
      const archName = arch === 1 ? 'x64' : 'arm64'; // Arch.x64 = 1, Arch.arm64 = 4
      const keep = archName === 'arm64' ? 'linux-arm64' : 'linux-x64';

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

  if (platform === 'win32') {
    try {
      console.log('🧹 [Windows] 清理非Windows预构建...');
      // 清理其他平台的预构建文件
      execSync(`rd /s /q "${appRoot}\\node_modules\\wsjtx-lib\\prebuilds\\darwin-*" 2>nul || exit 0`, { stdio: 'inherit' });
      execSync(`rd /s /q "${appRoot}\\node_modules\\wsjtx-lib\\prebuilds\\linux-*" 2>nul || exit 0`, { stdio: 'inherit' });
      console.log('✅ [Windows] 清理完成');
    } catch (error) {
      console.warn('⚠️ [Windows] 清理跨架构文件时出现警告:', error.message);
    }
  }

  console.log('✅ After-pack hook completed');
};
