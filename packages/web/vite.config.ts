import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './', // 使用相对路径，支持 Electron 生产环境
  build: {
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        logbook: resolve(__dirname, 'logbook.html'),
        spectrum: resolve(__dirname, 'spectrum.html'),
      },
    },
  },
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      events: 'events',
    },
  },
  optimizeDeps: {
    include: ['events'],
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    allowedHosts: true,
    proxy: {
      // 代理所有 /api 请求到后端服务器（包括WebSocket）
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
        ws: true, // 支持WebSocket代理
        configure: (proxy, _options) => {
          proxy.on('error', (err: any, _req: any, res: any) => {
            // 当后端未启动或不可达时，http-proxy 会抛出 ECONNREFUSED 等错误
            const isBackendOffline = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(err?.code);

            // 注意：在 WS 握手失败的场景下，res 可能是 net.Socket 而不是 ServerResponse
            const canWriteHead = res && typeof res.writeHead === 'function';
            const canEnd = res && typeof res.end === 'function';

            if (canWriteHead && !res.headersSent) {
              try {
                res.writeHead(isBackendOffline ? 503 : 502, {
                  'Content-Type': 'application/json; charset=utf-8',
                  'x-proxy-error': isBackendOffline ? 'backend_offline' : 'proxy_error',
                });
                const payload = {
                  success: false,
                  code: isBackendOffline ? 'BACKEND_OFFLINE' : 'PROXY_ERROR',
                  message: isBackendOffline
                    ? 'Backend server unavailable (dev proxy)'
                    : `Proxy error: ${err?.message || 'unknown error'}`,
                };
                res.end(JSON.stringify(payload));
              } catch (e) {
                try { canEnd && res.end(); } catch {}
              }
            } else if (canEnd) {
              // WS 或无法写响应头的场景，直接结束连接即可
              try { res.end(); } catch {}
            } else {
              console.log('[proxy] error (cannot write response):', err?.code || '', err?.message || err);
            }
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('[proxy] ->', req.method, req.url, proxyReq.getHeader('host') + proxyReq.path);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('[proxy] <-', req.method, req.url, proxyRes.statusCode);
          });
        },
      },
    },
  },
}); 
