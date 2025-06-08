#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// 检查是否安装了png-to-ico包
async function generateIco() {
  const PNG_PATH = path.join(__dirname, '../packages/electron-main/assets/icon.png');
  const ICO_PATH = path.join(__dirname, '../packages/electron-main/assets/icon.ico');

  if (!fs.existsSync(PNG_PATH)) {
    console.log('PNG图标文件不存在:', PNG_PATH);
    return;
  }

  if (fs.existsSync(ICO_PATH)) {
    console.log('ICO文件已存在，跳过生成');
    return;
  }

  try {
    // 动态导入png-to-ico
    const pngToIco = require('png-to-ico');
    
    console.log('正在从PNG生成ICO文件...');
    const buffer = await pngToIco(PNG_PATH);
    fs.writeFileSync(ICO_PATH, buffer);
    console.log('ICO文件生成成功:', ICO_PATH);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      console.log('png-to-ico未安装，尝试安装...');
      const { execSync } = require('child_process');
      
      try {
        execSync('yarn add -D png-to-ico', { stdio: 'inherit' });
        
        // 重新尝试
        const pngToIco = require('png-to-ico');
        console.log('正在从PNG生成ICO文件...');
        const buffer = await pngToIco(PNG_PATH);
        fs.writeFileSync(ICO_PATH, buffer);
        console.log('ICO文件生成成功:', ICO_PATH);
      } catch (installError) {
        console.error('安装png-to-ico失败:', installError.message);
        console.log('请手动运行: yarn add -D png-to-ico');
        process.exit(1);
      }
    } else {
      console.error('生成ICO文件失败:', error.message);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  generateIco().catch(console.error);
}

module.exports = generateIco; 