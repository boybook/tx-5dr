import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // 使用相对路径，支持 Electron 生产环境
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      // 代理所有 /api 请求到后端服务器（包括WebSocket）
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
        ws: true, // 支持WebSocket代理
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('🚨 代理错误:', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('📤 代理请求:', req.method, req.url, '→', proxyReq.getHeader('host') + proxyReq.path);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('📥 代理响应:', req.method, req.url, '←', proxyRes.statusCode);
          });
        },
      },
    },
  },
}); 