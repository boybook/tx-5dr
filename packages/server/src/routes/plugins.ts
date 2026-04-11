import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { promises as fs } from 'fs';
import path from 'path';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { getPluginRuntimeInfo } from '../plugin/runtime-info.js';

const logger = createLogger('PluginRoutes');

/**
 * 插件管理 REST API
 *
 * GET  /api/plugins                               — 列出所有插件及状态
 * POST /api/plugins/:name/enable                 — 启用插件
 * POST /api/plugins/:name/disable                — 禁用插件
 * POST /api/plugins/:name/reload                 — 热重载单个插件
 * GET  /api/plugins/runtime-info                 — 获取插件宿主目录与运行形态
 * GET  /api/plugins/:name/settings               — 获取 global scope 插件设置
 * PUT  /api/plugins/:name/settings               — 更新 global scope 插件设置
 * GET  /api/plugins/:name/operator/:id/settings  — 获取操作员维度插件设置
 * PUT  /api/plugins/:name/operator/:id/settings  — 更新操作员维度插件设置
 * POST /api/plugins/reload                       — 热重载全部插件
 * POST /api/plugins/rescan                       — 重扫插件目录
 * PUT  /api/plugins/operators/:id/strategy       — 设置操作员策略插件
 */
export async function pluginRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();

  const getResolvedGlobalSettings = (name: string): Record<string, unknown> => {
    const config = ConfigManager.getInstance().getPluginsConfig();
    const storedGlobalSettings = config.configs?.[name]?.settings ?? {};
    const plugin = engine.pluginManager.getSnapshot().plugins.find((entry) => entry.name === name);
    if (!plugin?.settings) {
      return storedGlobalSettings;
    }

    const resolved = { ...storedGlobalSettings };
    const operatorSettingsMap = config.operatorSettings ?? {};

    for (const [key, descriptor] of Object.entries(plugin.settings)) {
      if (descriptor.type === 'info' || descriptor.scope === 'operator' || key in resolved) {
        continue;
      }

      for (const pluginSettingsByOperator of Object.values(operatorSettingsMap)) {
        const legacySettings = pluginSettingsByOperator?.[name];
        if (!legacySettings || !(key in legacySettings)) {
          continue;
        }

        const value = legacySettings[key];
        if (descriptor.type === 'string[]') {
          const previous = Array.isArray(resolved[key]) ? resolved[key] as unknown[] : [];
          const incoming = Array.isArray(value) ? value : [];
          resolved[key] = Array.from(new Set([
            ...previous.filter((entry): entry is string => typeof entry === 'string'),
            ...incoming.filter((entry): entry is string => typeof entry === 'string'),
          ]));
          continue;
        }

        resolved[key] = value;
        break;
      }
    }

    return resolved;
  };

  // GET /api/plugins
  fastify.get('/', async (_req, reply) => {
    return reply.send(engine.pluginManager.getSnapshot());
  });

  fastify.get('/runtime-info', async (_req, reply) => {
    return reply.send(await getPluginRuntimeInfo());
  });

  // POST /api/plugins/:name/enable
  fastify.post<{ Params: { name: string } }>('/:name/enable', async (req, reply) => {
    const { name } = req.params;
    const plugin = engine.pluginManager.getSnapshot().plugins.find((entry) => entry.name === name);
    if (!plugin) {
      return reply.status(404).send({ error: 'plugin not found' });
    }
    if (plugin.type !== 'utility') {
      return reply.status(400).send({ error: 'strategy plugin cannot be enabled or disabled' });
    }
    const existing = ConfigManager.getInstance().getPluginsConfig().configs?.[name] ?? { enabled: false, settings: {} };
    engine.pluginManager.setPluginEnabled(name, true);
    await ConfigManager.getInstance().setPluginConfig(name, {
      enabled: true,
      settings: existing.settings ?? {},
    });
    logger.info(`Plugin enabled: ${name}`);
    return reply.send({ success: true });
  });

  // POST /api/plugins/:name/disable
  fastify.post<{ Params: { name: string } }>('/:name/disable', async (req, reply) => {
    const { name } = req.params;
    const plugin = engine.pluginManager.getSnapshot().plugins.find((entry) => entry.name === name);
    if (!plugin) {
      return reply.status(404).send({ error: 'plugin not found' });
    }
    if (plugin.type !== 'utility') {
      return reply.status(400).send({ error: 'strategy plugin cannot be enabled or disabled' });
    }
    engine.pluginManager.setPluginEnabled(name, false);
    const existing = ConfigManager.getInstance().getPluginsConfig().configs?.[name] ?? { enabled: false, settings: {} };
    await ConfigManager.getInstance().setPluginConfig(name, { ...existing, enabled: false });
    logger.info(`Plugin disabled: ${name}`);
    return reply.send({ success: true });
  });

  // GET /api/plugins/:name/settings — global scope
  fastify.get<{ Params: { name: string } }>(
    '/:name/settings',
    async (req, reply) => {
      const { name } = req.params;
      const settings = getResolvedGlobalSettings(name);
      return reply.send({ settings });
    },
  );

  // PUT /api/plugins/:name/settings — global scope
  fastify.put<{ Params: { name: string }; Body: { settings: Record<string, unknown> } }>(
    '/:name/settings',
    async (req, reply) => {
      const { name } = req.params;
      const { settings } = req.body ?? {};
      if (!settings || typeof settings !== 'object') {
        return reply.status(400).send({ error: 'settings must be an object' });
      }
      engine.pluginManager.setPluginSettings(name, settings);
      const existing = ConfigManager.getInstance().getPluginsConfig().configs?.[name] ?? { enabled: false, settings: {} };
      await ConfigManager.getInstance().setPluginConfig(name, { ...existing, settings });
      logger.info(`Plugin global settings updated: ${name}`);
      return reply.send({ success: true });
    },
  );

  // GET /api/plugins/:name/operator/:operatorId/settings — operator scope
  fastify.get<{ Params: { name: string; operatorId: string } }>(
    '/:name/operator/:operatorId/settings',
    async (req, reply) => {
      const { name, operatorId } = req.params;
      const settings = engine.pluginManager.getOperatorPluginSettings(operatorId, name);
      return reply.send({ settings });
    },
  );

  fastify.get<{ Params: { operatorId: string } }>(
    '/operators/:operatorId',
    async (req, reply) => {
      const { operatorId } = req.params;
      const pluginSnapshot = engine.pluginManager.getSnapshot();
      const runtimeState = engine.pluginManager.getOperatorRuntimeStatus(operatorId);
      const operatorSettings = ConfigManager.getInstance().getPluginsConfig().operatorSettings?.[operatorId] ?? {};

      return reply.send({
        operatorId,
        currentStrategy: runtimeState.strategyName,
        strategyState: runtimeState.currentSlot,
        slots: runtimeState.slots ?? {},
        context: runtimeState.context ?? {},
        operatorSettings,
        pluginSnapshot,
        plugins: pluginSnapshot.plugins.map((plugin) => ({
          ...plugin,
          currentSettings: operatorSettings[plugin.name] ?? {},
        })),
      });
    },
  );

  // PUT /api/plugins/:name/operator/:operatorId/settings — operator scope
  fastify.put<{
    Params: { name: string; operatorId: string };
    Body: { settings: Record<string, unknown> };
  }>(
    '/:name/operator/:operatorId/settings',
    async (req, reply) => {
      const { name, operatorId } = req.params;
      const { settings } = req.body ?? {};
      if (!settings || typeof settings !== 'object') {
        return reply.status(400).send({ error: 'settings must be an object' });
      }
      engine.pluginManager.setOperatorPluginSettings(operatorId, name, settings);
      await ConfigManager.getInstance().setOperatorPluginSettings(operatorId, name, settings);
      logger.info(`Plugin operator settings updated: plugin=${name}, operator=${operatorId}`);
      return reply.send({ success: true });
    },
  );

  // POST /api/plugins/reload
  fastify.post('/reload', async (_req, reply) => {
    await engine.pluginManager.reloadPlugins();
    logger.info('All plugins reloaded');
    return reply.send({ success: true });
  });

  fastify.post<{ Params: { name: string } }>('/:name/reload', async (req, reply) => {
    const { name } = req.params;
    await engine.pluginManager.reloadPlugin(name);
    logger.info(`Plugin reloaded: ${name}`);
    return reply.send({ success: true });
  });

  fastify.post('/rescan', async (_req, reply) => {
    await engine.pluginManager.rescanPlugins();
    logger.info('Plugins rescanned');
    return reply.send({ success: true });
  });

  // PUT /api/plugins/operators/:id/strategy
  fastify.put<{ Params: { id: string }; Body: { pluginName: string } }>(
    '/operators/:id/strategy',
    async (req, reply) => {
      const { id } = req.params;
      const { pluginName } = req.body ?? {};
      if (!pluginName) {
        return reply.status(400).send({ error: 'pluginName is required' });
      }
      engine.pluginManager.setOperatorStrategy(id, pluginName);
      await ConfigManager.getInstance().setOperatorStrategy(id, pluginName);
      logger.info(`Operator strategy set: operator=${id}, plugin=${pluginName}`);
      return reply.send({ success: true });
    },
  );

  // ===== Plugin UI: static files, CSS tokens, bridge SDK, invoke =====

  registerPluginUIRoutes(fastify, engine);

  // ===== Logbook sync provider endpoints =====

  // GET /api/plugins/sync-providers
  fastify.get('/sync-providers', async (_req, reply) => {
    return reply.send(engine.pluginManager.logbookSyncHost.getProviders());
  });

  // GET /api/plugins/sync-providers/configured?callsign=XX
  fastify.get<{ Querystring: { callsign?: string } }>('/sync-providers/configured', async (req, reply) => {
    const callsign = (req.query as Record<string, string>).callsign ?? '';
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign query parameter is required' });
    }
    const providers = engine.pluginManager.logbookSyncHost.getConfiguredStatus(callsign);
    return reply.send({ providers });
  });

  // POST /api/plugins/sync-providers/:providerId/test-connection
  fastify.post<{
    Params: { providerId: string };
    Body: { callsign: string };
  }>('/sync-providers/:providerId/test-connection', async (req, reply) => {
    const { providerId } = req.params;
    const { callsign } = req.body ?? {};
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign is required' });
    }
    const result = await engine.pluginManager.logbookSyncHost.testConnection(providerId, callsign);
    return reply.send(result);
  });

  // POST /api/plugins/sync-providers/:providerId/upload
  fastify.post<{
    Params: { providerId: string };
    Body: { callsign: string };
  }>('/sync-providers/:providerId/upload', async (req, reply) => {
    const { providerId } = req.params;
    const { callsign } = req.body ?? {};
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign is required' });
    }

    try {
      const result = await engine.pluginManager.logbookSyncHost.upload(providerId, callsign);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      logger.error(`Sync upload failed: provider=${providerId}`, err);
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/plugins/sync-providers/:providerId/download
  fastify.post<{
    Params: { providerId: string };
    Body: { callsign: string; since?: number };
  }>('/sync-providers/:providerId/download', async (req, reply) => {
    const { providerId } = req.params;
    const { callsign, since } = req.body ?? {};
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign is required' });
    }

    try {
      const options = since ? { since } : undefined;
      const result = await engine.pluginManager.logbookSyncHost.download(providerId, callsign, options);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Download failed';
      logger.error(`Sync download failed: provider=${providerId}`, err);
      return reply.status(500).send({ error: message });
    }
  });
}

// ===== MIME type lookup =====

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function getMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// ===== CSS design tokens =====

function generateCSSTokens(theme: 'dark' | 'light'): string {
  const dark = theme === 'dark';
  return `/* TX-5DR Plugin Design Tokens — auto-generated */
:root {
  --tx5dr-bg: ${dark ? '#18181b' : '#ffffff'};
  --tx5dr-bg-content: ${dark ? '#27272a' : '#f4f4f5'};
  --tx5dr-bg-hover: ${dark ? '#3f3f46' : '#e4e4e7'};
  --tx5dr-text: ${dark ? '#fafafa' : '#18181b'};
  --tx5dr-text-secondary: ${dark ? '#a1a1aa' : '#71717a'};
  --tx5dr-primary: #006FEE;
  --tx5dr-primary-hover: #005bc4;
  --tx5dr-success: #17c964;
  --tx5dr-warning: #f5a524;
  --tx5dr-danger: #f31260;
  --tx5dr-border: ${dark ? '#3f3f46' : '#d4d4d8'};
  --tx5dr-focus-ring: rgba(0, 111, 238, 0.4);
  --tx5dr-radius-sm: 8px;
  --tx5dr-radius-md: 12px;
  --tx5dr-radius-lg: 16px;
  --tx5dr-spacing-xs: 4px;
  --tx5dr-spacing-sm: 8px;
  --tx5dr-spacing-md: 12px;
  --tx5dr-spacing-lg: 16px;
  --tx5dr-spacing-xl: 24px;
  --tx5dr-font: 'Inter', system-ui, -apple-system, sans-serif;
  --tx5dr-font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --tx5dr-font-size-sm: 13px;
  --tx5dr-font-size-md: 14px;
  --tx5dr-font-size-lg: 16px;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; }
html, body {
  font-family: var(--tx5dr-font);
  font-size: var(--tx5dr-font-size-md);
  color: var(--tx5dr-text);
  background: var(--tx5dr-bg);
  line-height: 1.5;
}
`;
}

// ===== Bridge SDK =====

const BRIDGE_SDK = `/* TX-5DR Plugin Bridge SDK */
(function() {
  'use strict';
  var pending = {};
  var pushListeners = {};
  var themeListeners = [];
  var nextId = 1;
  var state = { params: {}, theme: 'dark', locale: 'en' };

  // === Theme-aware CSS variable tokens ===
  var THEME_TOKENS = {
    dark: {
      '--tx5dr-bg': '#18181b',
      '--tx5dr-bg-content': '#27272a',
      '--tx5dr-bg-hover': '#3f3f46',
      '--tx5dr-text': '#fafafa',
      '--tx5dr-text-secondary': '#a1a1aa',
      '--tx5dr-border': '#3f3f46'
    },
    light: {
      '--tx5dr-bg': '#ffffff',
      '--tx5dr-bg-content': '#f4f4f5',
      '--tx5dr-bg-hover': '#e4e4e7',
      '--tx5dr-text': '#18181b',
      '--tx5dr-text-secondary': '#71717a',
      '--tx5dr-border': '#d4d4d8'
    }
  };

  function applyThemeTokens(theme) {
    var tokens = THEME_TOKENS[theme] || THEME_TOKENS.dark;
    var root = document.documentElement;
    for (var key in tokens) {
      root.style.setProperty(key, tokens[key]);
    }
  }

  // Apply theme immediately from URL params (available before postMessage).
  var urlTheme = new URLSearchParams(window.location.search).get('_theme');
  if (urlTheme) {
    state.theme = urlTheme;
    applyThemeTokens(urlTheme);
  }

  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('tx5dr:')) return;
    if (msg.type === 'tx5dr:init') {
      state.params = msg.params || {};
      state.theme = msg.theme || 'dark';
      state.locale = msg.locale || 'en';
      applyThemeTokens(state.theme);
      return;
    }
    if (msg.type === 'tx5dr:theme-changed') {
      state.theme = msg.theme;
      applyThemeTokens(state.theme);
      themeListeners.forEach(function(cb) { cb(msg.theme); });
      return;
    }
    if (msg.type === 'tx5dr:push') {
      var cbs = pushListeners[msg.action];
      if (cbs) cbs.forEach(function(cb) { try { cb(msg.data); } catch(err) { console.error(err); } });
      return;
    }
    if (msg.type === 'tx5dr:response' && msg.requestId && pending[msg.requestId]) {
      var p = pending[msg.requestId];
      delete pending[msg.requestId];
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  function request(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = 'r' + (nextId++);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = Object.assign({ type: type, requestId: id }, payload);
      window.parent.postMessage(msg, '*');
    });
  }

  window.tx5dr = {
    get params() { return state.params; },
    get theme() { return state.theme; },
    get locale() { return state.locale; },
    storeGet: function(key, def) { return request('tx5dr:store:get', { key: key }).then(function(v) { return v != null ? v : def; }); },
    storeSet: function(key, value) { return request('tx5dr:store:set', { key: key, value: value }); },
    storeDelete: function(key) { return request('tx5dr:store:delete', { key: key }); },
    fileUpload: function(p, file) {
      return file.arrayBuffer().then(function(buf) {
        return request('tx5dr:file:upload', { path: p, data: buf });
      });
    },
    fileRead: function(p) { return request('tx5dr:file:read', { path: p }).then(function(v) { return v ? new Blob([v]) : null; }); },
    fileDelete: function(p) { return request('tx5dr:file:delete', { path: p }); },
    fileList: function(prefix) { return request('tx5dr:file:list', { prefix: prefix || '' }); },
    requestClose: function() { window.parent.postMessage({ type: 'tx5dr:request-close' }, '*'); },
    onThemeChange: function(cb) { themeListeners.push(cb); },
    invoke: function(action, data) { return request('tx5dr:invoke', { action: action, data: data }); },
    onPush: function(action, cb) {
      if (!pushListeners[action]) pushListeners[action] = [];
      pushListeners[action].push(cb);
    },
    offPush: function(action, cb) {
      var arr = pushListeners[action];
      if (arr) pushListeners[action] = arr.filter(function(f) { return f !== cb; });
    },
    resize: function(height) { window.parent.postMessage({ type: 'tx5dr:resize', height: height }, '*'); },
  };
})();
`;

// ===== Safe path resolution =====

function resolveSafePath(root: string, relative: string): string | null {
  const normalized = path.normalize(relative);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) return null;
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

// ===== Token injection into HTML =====

const TOKEN_LINK = '<link rel="stylesheet" href="/api/plugins/_bridge/tokens.css">';
const BRIDGE_SCRIPT = '<script src="/api/plugins/_bridge/bridge.js"></' + 'script>';

function injectIntoHTML(html: string): string {
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) {
    return html.slice(0, headClose) + TOKEN_LINK + '\n' + BRIDGE_SCRIPT + '\n' + html.slice(headClose);
  }
  return TOKEN_LINK + '\n' + BRIDGE_SCRIPT + '\n' + html;
}

// ===== Route registration =====

function registerPluginUIRoutes(fastify: FastifyInstance, engine: DigitalRadioEngine): void {

  // GET /api/plugins/_bridge/tokens.css
  fastify.get('/_bridge/tokens.css', async (req: FastifyRequest, reply: FastifyReply) => {
    const theme = (req.query as Record<string, string>).theme === 'light' ? 'light' : 'dark';
    return reply.type('text/css; charset=utf-8').send(generateCSSTokens(theme));
  });

  // GET /api/plugins/_bridge/bridge.js
  fastify.get('/_bridge/bridge.js', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.type('application/javascript; charset=utf-8').send(BRIDGE_SDK);
  });

  // GET /api/plugins/:name/ui/* — serve plugin static files
  fastify.get<{ Params: { name: string; '*': string } }>(
    '/:name/ui/*',
    async (req, reply) => {
      const { name } = req.params;
      const filePath = req.params['*'] || 'index.html';

      const loaded = engine.pluginManager.getLoadedPlugin(name);
      if (!loaded) {
        return reply.status(404).send({ error: 'Plugin not found' });
      }

      if (!loaded.dirPath) {
        return reply.status(404).send({ error: 'Plugin has no static file directory' });
      }

      const uiDir = loaded.definition.ui?.dir ?? 'ui';
      const root = path.resolve(loaded.dirPath, uiDir);
      const resolved = resolveSafePath(root, filePath);
      if (!resolved) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      try {
        const content = await fs.readFile(resolved);
        const mime = getMimeType(resolved);

        // Auto-inject tokens.css and bridge.js into HTML files
        if (mime.startsWith('text/html')) {
          return reply.type(mime).send(injectIntoHTML(content.toString('utf-8')));
        }

        return reply.type(mime).send(content);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'File not found' });
        }
        throw err;
      }
    },
  );

  // POST /api/plugins/:name/ui-invoke — route iframe invoke to plugin handler
  fastify.post<{
    Params: { name: string };
    Body: { pageId: string; action: string; data?: unknown };
  }>(
    '/:name/ui-invoke',
    async (req, reply) => {
      const { name } = req.params;
      const { pageId, action, data } = req.body ?? {};

      if (!pageId || !action) {
        return reply.status(400).send({ error: 'pageId and action are required' });
      }

      try {
        const result = await engine.pluginManager.invokePluginPageHandler(name, pageId, action, data);
        return reply.send({ result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.warn(`Plugin UI invoke failed: plugin=${name}, action=${action}`, { error: message });
        return reply.status(500).send({ error: message });
      }
    },
  );
}
