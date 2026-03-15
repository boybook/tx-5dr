/**
 * dev:electron 启动脚本
 * 启动 turbo dev（server + web + electron-main）
 * Admin Token 由 Server 启动时自动生成并写入 .admin-token 文件，Electron 从文件读取
 */
const { spawn } = require('child_process');

const child = spawn(
  'yarn',
  ['turbo', 'run', 'dev', '--parallel', '--filter=!@tx5dr/client-tools'],
  { stdio: 'inherit', env: process.env, shell: true }
);

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
