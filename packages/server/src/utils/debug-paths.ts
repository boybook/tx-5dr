import { getAllAppPaths } from './app-paths.js';

/**
 * 打印所有应用程序路径信息（用于调试）
 */
export async function printAppPaths(): Promise<void> {
  console.log('\n📁 ===== TX-5DR 应用程序路径信息 =====');
  
  try {
    const paths = await getAllAppPaths();
    
    console.log(`🖥️  操作系统: ${paths.platform}`);
    console.log(`⚙️  配置目录: ${paths.configDir}`);
    console.log(`📊 数据目录: ${paths.dataDir}`);
    console.log(`📝 日志目录: ${paths.logsDir}`);
    console.log(`🗃️  缓存目录: ${paths.cacheDir}`);
    
    console.log('\n📁 ===== 路径说明 =====');
    switch (paths.platform) {
      case 'win32':
        console.log('Windows 系统路径标准:');
        console.log('  - 配置: %APPDATA%\\TX-5DR');
        console.log('  - 数据: %LOCALAPPDATA%\\TX-5DR');
        console.log('  - 日志: %LOCALAPPDATA%\\TX-5DR\\logs');
        console.log('  - 缓存: %LOCALAPPDATA%\\TX-5DR\\cache');
        break;
      case 'darwin':
        console.log('macOS 系统路径标准:');
        console.log('  - 配置: ~/Library/Application Support/TX-5DR');
        console.log('  - 数据: ~/Library/Application Support/TX-5DR');
        console.log('  - 日志: ~/Library/Logs/TX-5DR');
        console.log('  - 缓存: ~/Library/Caches/TX-5DR');
        break;
      default:
        console.log('Linux 系统路径标准:');
        console.log('  - 配置: ~/.config/TX-5DR');
        console.log('  - 数据: ~/.local/share/TX-5DR');
        console.log('  - 日志: ~/.local/share/TX-5DR/logs');
        console.log('  - 缓存: ~/.cache/TX-5DR');
        break;
    }
    
    console.log('\n✅ 所有目录已自动创建并准备就绪\n');
    
  } catch (error) {
    console.error('❌ 获取路径信息失败:', error);
  }
} 