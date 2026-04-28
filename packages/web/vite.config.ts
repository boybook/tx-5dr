import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import type { ProxyOptions } from 'vite';

// Keep CI/local builds quiet until we intentionally refresh the browserslist DB.
process.env.BROWSERSLIST_IGNORE_OLD_DATA = 'true';
const DEFAULT_WEB_PORT = 8076;
const configuredWebPort = Number(process.env.WEB_PORT || process.env.TX5DR_WEB_DEV_PORT || DEFAULT_WEB_PORT);

function createProxyOptions(target: string, options?: { rewrite?: (path: string) => string }): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    secure: false,
    ws: true,
    rewrite: options?.rewrite,
    configure: (proxy) => {
      proxy.on('error', (err: any, _req: any, res: any) => {
        const isBackendOffline = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(err?.code);
        const canWriteHead = res && typeof res.writeHead === 'function';
        const canEnd = res && typeof res.end === 'function';

        if (canWriteHead && !res.headersSent) {
          try {
            res.writeHead(isBackendOffline ? 503 : 502, {
              'Content-Type': 'application/json; charset=utf-8',
              'x-proxy-error': isBackendOffline ? 'backend_offline' : 'proxy_error',
            });
            res.end(JSON.stringify({
              success: false,
              code: isBackendOffline ? 'BACKEND_OFFLINE' : 'PROXY_ERROR',
              message: isBackendOffline
                ? 'Backend server unavailable (dev proxy)'
                : `Proxy error: ${err?.message || 'unknown error'}`,
            }));
          } catch {
            try { canEnd && res.end(); } catch {}
          }
        } else if (canEnd) {
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
  };
}

export default defineConfig({
  plugins: [react()],
  base: './', // 使用相对路径，支持 Electron 生产环境
  build: {
    // Multi-entry bundles intentionally carry large route-specific assets for now.
    chunkSizeWarningLimit: 2300,
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
    port: Number.isFinite(configuredWebPort) ? configuredWebPort : DEFAULT_WEB_PORT,
    host: '0.0.0.0',
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': createProxyOptions('http://localhost:4000'),
    },
  },
}); 
