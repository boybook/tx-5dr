const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // 只对 macOS 进行公证
  if (electronPlatformName !== 'darwin') {
    console.log('跳过公证: 非 macOS 平台');
    return;
  }

  // 检查是否在 CI 环境且有必要的凭据
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID || '85SV63Z4H5';

  // 如果没有配置公证凭据，跳过公证（本地开发）
  if (!appleId || !appleIdPassword) {
    console.log('⚠️  跳过公证: 未设置 APPLE_ID 或 APPLE_APP_SPECIFIC_PASSWORD 环境变量');
    console.log('   如需公证，请设置以下环境变量：');
    console.log('   - APPLE_ID: 你的 Apple ID');
    console.log('   - APPLE_APP_SPECIFIC_PASSWORD: 应用专用密码');
    console.log('   - APPLE_TEAM_ID: 团队 ID (默认: 85SV63Z4H5)');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log('🔐 开始公证应用...');
  console.log(`   应用路径: ${appPath}`);
  console.log(`   Apple ID: ${appleId}`);
  console.log(`   Team ID: ${teamId}`);

  try {
    await notarize({
      appPath,
      appleId,
      appleIdPassword,
      teamId,
    });

    console.log('✅ 公证成功！');
  } catch (error) {
    console.error('❌ 公证失败:', error);

    // 在 CI 环境中，公证失败应该导致构建失败
    if (process.env.CI) {
      throw error;
    }

    // 在本地环境中，只警告不中断构建
    console.warn('⚠️  公证失败，但构建将继续...');
  }
};