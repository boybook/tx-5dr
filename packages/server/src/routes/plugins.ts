import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { promises as fs } from 'fs';
import path from 'path';
import type { PluginUIInstanceTarget } from '@tx5dr/plugin-api';
import type {
  JWTPayload,
  PermissionGrant,
  PluginMarketChannel,
  PluginUIPageDescriptor,
} from '@tx5dr/contracts';
import { PluginMarketChannelSchema, UserRole } from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { AuthManager } from '../auth/AuthManager.js';
import { createLogger } from '../utils/logger.js';
import { getPluginRuntimeInfo } from '../plugin/runtime-info.js';
import { fetchPluginMarketCatalog } from '../plugin/marketplace.js';
import {
  installPluginFromMarketplace,
  uninstallPluginFromMarketplace,
  updatePluginFromMarketplace,
} from '../plugin/marketplace-installer.js';
import { normalizeCallsign } from '../utils/callsign.js';
import {
  type PluginPageSession,
} from '../plugin/PluginPageSessionStore.js';
import { ScopedPluginFileStoreProvider } from '../plugin/ScopedPluginFileStoreProvider.js';
import { PluginStorageProvider } from '../plugin/PluginStorageProvider.js';
import { PluginFileStoreProvider } from '../plugin/PluginFileStoreProvider.js';
import { getPluginBridgeSdkScript } from '../plugin/bridge-sdk.js';
import {
  type PluginPageBoundResource,
  getPluginPageFileScopePath,
  getPluginPageStorePath,
} from '../plugin/page-scope.js';

const logger = createLogger('PluginRoutes');

const UNAUTHORIZED_RESPONSE = {
  success: false,
  error: { code: 'UNAUTHORIZED', message: 'Authentication required', userMessage: 'Please login first' },
} as const;

const FORBIDDEN_RESPONSE = {
  success: false,
  error: { code: 'FORBIDDEN', message: 'Permission denied', userMessage: 'You do not have permission for this operation' },
} as const;

type RuntimeAuthUser = NonNullable<FastifyRequest['authUser']>;

function getQueryToken(request: FastifyRequest): string | null {
  const query = request.query as Record<string, unknown>;
  const authToken = query.auth_token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }
  const fallbackToken = query.token;
  return typeof fallbackToken === 'string' && fallbackToken.trim() ? fallbackToken.trim() : null;
}

async function resolveRuntimeAuthUser(
  fastify: FastifyInstance,
  request: FastifyRequest,
  allowQueryToken = false,
): Promise<RuntimeAuthUser | null> {
  if (request.authUser) {
    return request.authUser;
  }

  if (!allowQueryToken) {
    return null;
  }

  const authManager = AuthManager.getInstance();
  if (!authManager.isAuthEnabled()) {
    return request.authUser;
  }

  const token = getQueryToken(request);
  if (!token) {
    return null;
  }

  let decoded: JWTPayload;
  try {
    decoded = fastify.jwt.verify<JWTPayload>(token);
  } catch {
    return null;
  }

  if (!authManager.isTokenStillValid(decoded.tokenId)) {
    return null;
  }

  const current = authManager.getTokenCurrentPermissions(decoded.tokenId);
  if (!current) {
    return null;
  }

  return {
    ...decoded,
    role: current.role,
    operatorIds: current.operatorIds,
    permissionGrants: current.permissionGrants,
  };
}

async function requireMinimumRole(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  minRole: UserRole,
  allowQueryToken = false,
): Promise<RuntimeAuthUser | null> {
  const user = await resolveRuntimeAuthUser(fastify, request, allowQueryToken);
  if (!user) {
    await reply.code(401).send(UNAUTHORIZED_RESPONSE);
    return null;
  }
  if (!AuthManager.hasMinRole(user.role, minRole)) {
    await reply.code(403).send(FORBIDDEN_RESPONSE);
    return null;
  }
  return user;
}

function userHasCallsignAccess(user: RuntimeAuthUser, callsign: string): boolean {
  if (user.role === UserRole.ADMIN) {
    return true;
  }

  const target = normalizeCallsign(callsign);
  const operators = ConfigManager.getInstance().getOperatorsConfig();
  const allowedCallsigns = new Set(
    operators
      .filter((operator) => user.operatorIds.includes(operator.id))
      .map((operator) => normalizeCallsign(operator.myCallsign)),
  );
  return allowedCallsigns.has(target);
}

function userHasOperatorAccess(user: RuntimeAuthUser, operatorId: string): boolean {
  return user.role === UserRole.ADMIN || user.operatorIds.includes(operatorId);
}

async function requireCallsignBindingAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  callsign: string,
  allowQueryToken = false,
): Promise<RuntimeAuthUser | null> {
  const user = await requireMinimumRole(fastify, request, reply, UserRole.OPERATOR, allowQueryToken);
  if (!user) {
    return null;
  }
  if (!userHasCallsignAccess(user, callsign)) {
    await reply.code(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No permission to access this callsign' },
    });
    return null;
  }
  return user;
}

async function requireOperatorBindingAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  operatorId: string,
  allowQueryToken = false,
): Promise<RuntimeAuthUser | null> {
  const user = await requireMinimumRole(fastify, request, reply, UserRole.OPERATOR, allowQueryToken);
  if (!user) {
    return null;
  }
  if (!userHasOperatorAccess(user, operatorId)) {
    await reply.code(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No operator access', userMessage: 'You do not have access to this operator' },
    });
    return null;
  }
  return user;
}

function getPluginPageDescriptor(
  engine: DigitalRadioEngine,
  pluginName: string,
  pageId: string,
): PluginUIPageDescriptor | null {
  const loaded = engine.pluginManager.getLoadedPlugin(pluginName);
  return loaded?.definition.ui?.pages?.find((page) => page.id === pageId) ?? null;
}

function getPageBindingValue(
  page: PluginUIPageDescriptor,
  requestData: unknown,
): PluginPageBoundResource | null {
  if (page.resourceBinding === 'none') {
    return null;
  }

  const data = requestData && typeof requestData === 'object'
    ? requestData as Record<string, unknown>
    : {};

  if (page.resourceBinding === 'callsign' && typeof data.callsign === 'string' && data.callsign.trim()) {
    return { kind: 'callsign', value: data.callsign.trim() };
  }

  if (page.resourceBinding === 'operator' && typeof data.operatorId === 'string' && data.operatorId.trim()) {
    return { kind: 'operator', value: data.operatorId.trim() };
  }

  return null;
}

function getPluginInstanceTarget(
  engine: DigitalRadioEngine,
  pluginName: string,
  requestData: unknown,
): PluginUIInstanceTarget | null {
  const loaded = engine.pluginManager.getLoadedPlugin(pluginName);
  const instanceScope = loaded?.definition.instanceScope ?? 'operator';
  if (instanceScope === 'global') {
    return { kind: 'global' };
  }

  const data = requestData && typeof requestData === 'object'
    ? requestData as Record<string, unknown>
    : {};
  if (typeof data.operatorId === 'string' && data.operatorId.trim()) {
    return { kind: 'operator', operatorId: data.operatorId.trim() };
  }

  return null;
}

function toPluginRequestRole(role: UserRole): 'viewer' | 'operator' | 'admin' {
  return role;
}

function toPluginRequestUser(user: RuntimeAuthUser): {
  tokenId: string;
  role: 'viewer' | 'operator' | 'admin';
  operatorIds: string[];
  permissionGrants?: PermissionGrant[];
} {
  return {
    tokenId: user.tokenId,
    role: toPluginRequestRole(user.role),
    operatorIds: user.operatorIds,
    permissionGrants: user.permissionGrants,
  };
}

function getPageMinimumRole(page: PluginUIPageDescriptor): UserRole {
  return page.accessScope === 'operator' ? UserRole.OPERATOR : UserRole.ADMIN;
}

async function requirePageAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  page: PluginUIPageDescriptor,
  allowQueryToken = false,
): Promise<RuntimeAuthUser | null> {
  return requireMinimumRole(
    fastify,
    request,
    reply,
    getPageMinimumRole(page),
    allowQueryToken,
  );
}

function createSessionBootstrapScript(sessionId: string): string {
  return `<script>window.__TX5DR_PAGE_SESSION_ID__=${JSON.stringify(sessionId)};</script>`;
}

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
 * GET  /api/plugins/market/catalog               — 获取官方插件市场索引
 * GET  /api/plugins/market/catalog/:name         — 获取单个市场插件条目
 * POST /api/plugins/market/:name/install         — 从官方市场安装插件
 * POST /api/plugins/market/:name/update          — 从官方市场更新插件
 * DELETE /api/plugins/market/:name               — 卸载市场插件（保留 plugin-data）
 */
export async function pluginRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();
  const configManager = ConfigManager.getInstance();

  const parseMarketChannel = (value: unknown): PluginMarketChannel | null => {
    const parsed = PluginMarketChannelSchema.safeParse(value ?? 'stable');
    return parsed.success ? parsed.data : null;
  };

  const getResolvedGlobalSettings = (name: string): Record<string, unknown> => {
    const config = configManager.getPluginsConfig();
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

  fastify.get('/', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }
    return reply.send(engine.pluginManager.getSnapshot());
  });

  fastify.get<{ Querystring: { channel?: string } }>('/market/catalog', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.VIEWER)) {
      return;
    }

    const channel = parseMarketChannel((req.query as { channel?: string } | undefined)?.channel);
    if (!channel) {
      return reply.status(400).send({
        code: 'INVALID_PLUGIN_MARKET_CHANNEL',
        message: 'Unsupported plugin market channel',
        userMessage: 'Unsupported plugin market channel',
      });
    }

    try {
      return reply.send(await fetchPluginMarketCatalog(channel));
    } catch (err) {
      logger.error(`Failed to fetch plugin marketplace catalog: channel=${channel}`, err);
      return reply.status(502).send({
        code: 'PLUGIN_MARKET_UNAVAILABLE',
        message: err instanceof Error ? err.message : 'Failed to fetch plugin marketplace catalog',
        userMessage: 'Plugin marketplace is temporarily unavailable',
      });
    }
  });

  fastify.get<{ Params: { name: string }; Querystring: { channel?: string } }>(
    '/market/catalog/:name',
    async (req, reply) => {
      if (!await requireMinimumRole(fastify, req, reply, UserRole.VIEWER)) {
        return;
      }

      const channel = parseMarketChannel((req.query as { channel?: string } | undefined)?.channel);
      if (!channel) {
        return reply.status(400).send({
          code: 'INVALID_PLUGIN_MARKET_CHANNEL',
          message: 'Unsupported plugin market channel',
          userMessage: 'Unsupported plugin market channel',
        });
      }

      try {
        const result = await fetchPluginMarketCatalog(channel);
        const plugin = result.catalog.plugins.find((entry: { name: string }) => entry.name === req.params.name);
        if (!plugin) {
          return reply.status(404).send({
            code: 'PLUGIN_MARKET_PLUGIN_NOT_FOUND',
            message: `Plugin not found in marketplace catalog: ${req.params.name}`,
            userMessage: 'Plugin not found in marketplace',
          });
        }

        return reply.send({
          plugin,
          channel,
          sourceUrl: result.sourceUrl,
        });
      } catch (err) {
        logger.error(`Failed to fetch plugin marketplace entry: channel=${channel}, plugin=${req.params.name}`, err);
        return reply.status(502).send({
          code: 'PLUGIN_MARKET_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'Failed to fetch plugin marketplace catalog',
          userMessage: 'Plugin marketplace is temporarily unavailable',
        });
      }
    },
  );

  fastify.post<{ Params: { name: string }; Body: { channel?: string } }>(
    '/market/:name/install',
    async (req, reply) => {
      if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
        return;
      }

      const channel = parseMarketChannel((req.body as { channel?: string } | undefined)?.channel);
      if (!channel) {
        return reply.status(400).send({
          code: 'INVALID_PLUGIN_MARKET_CHANNEL',
          message: 'Unsupported plugin market channel',
          userMessage: 'Unsupported plugin market channel',
        });
      }

      const runtimeInfo = await getPluginRuntimeInfo();
      const existing = engine.pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === req.params.name);
      if (existing?.isBuiltIn) {
        return reply.status(400).send({
          code: 'PLUGIN_MARKET_CONFLICTS_WITH_BUILTIN',
          message: `Built-in plugins cannot be replaced from marketplace: ${req.params.name}`,
          userMessage: 'Built-in plugins cannot be installed from marketplace',
        });
      }

      try {
        const result = await installPluginFromMarketplace(req.params.name, runtimeInfo.pluginDir, channel);
        await engine.pluginManager.rescanPlugins();
        return reply.send(result);
      } catch (err) {
        logger.error(`Failed to install plugin from marketplace: plugin=${req.params.name}, channel=${channel}`, err);
        return reply.status(502).send({
          code: 'PLUGIN_MARKET_INSTALL_FAILED',
          message: err instanceof Error ? err.message : 'Failed to install plugin from marketplace',
          userMessage: 'Plugin installation failed',
        });
      }
    },
  );

  fastify.post<{ Params: { name: string }; Body: { channel?: string } }>(
    '/market/:name/update',
    async (req, reply) => {
      if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
        return;
      }

      const channel = parseMarketChannel((req.body as { channel?: string } | undefined)?.channel);
      if (!channel) {
        return reply.status(400).send({
          code: 'INVALID_PLUGIN_MARKET_CHANNEL',
          message: 'Unsupported plugin market channel',
          userMessage: 'Unsupported plugin market channel',
        });
      }

      const installed = engine.pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === req.params.name);
      if (!installed || installed.isBuiltIn) {
        return reply.status(404).send({
          code: 'PLUGIN_MARKET_UPDATE_TARGET_NOT_FOUND',
          message: `Installed marketplace plugin not found: ${req.params.name}`,
          userMessage: 'Installed plugin not found',
        });
      }

      const runtimeInfo = await getPluginRuntimeInfo();
      try {
        const result = await updatePluginFromMarketplace(req.params.name, runtimeInfo.pluginDir, channel);
        await engine.pluginManager.rescanPlugins();
        return reply.send(result);
      } catch (err) {
        logger.error(`Failed to update plugin from marketplace: plugin=${req.params.name}, channel=${channel}`, err);
        return reply.status(502).send({
          code: 'PLUGIN_MARKET_UPDATE_FAILED',
          message: err instanceof Error ? err.message : 'Failed to update plugin from marketplace',
          userMessage: 'Plugin update failed',
        });
      }
    },
  );

  fastify.delete<{ Params: { name: string } }>(
    '/market/:name',
    async (req, reply) => {
      if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
        return;
      }

      const installed = engine.pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === req.params.name);
      if (!installed) {
        return reply.status(404).send({
          code: 'PLUGIN_MARKET_UNINSTALL_TARGET_NOT_FOUND',
          message: `Installed plugin not found: ${req.params.name}`,
          userMessage: 'Installed plugin not found',
        });
      }
      if (installed.isBuiltIn) {
        return reply.status(400).send({
          code: 'PLUGIN_MARKET_CANNOT_UNINSTALL_BUILTIN',
          message: `Built-in plugins cannot be uninstalled: ${req.params.name}`,
          userMessage: 'Built-in plugins cannot be uninstalled',
        });
      }

      const runtimeInfo = await getPluginRuntimeInfo();
      try {
        const result = await uninstallPluginFromMarketplace(req.params.name, runtimeInfo.pluginDir);
        await engine.pluginManager.rescanPlugins();
        return reply.send(result);
      } catch (err) {
        logger.error(`Failed to uninstall plugin from marketplace: plugin=${req.params.name}`, err);
        return reply.status(500).send({
          code: 'PLUGIN_MARKET_UNINSTALL_FAILED',
          message: err instanceof Error ? err.message : 'Failed to uninstall plugin from marketplace',
          userMessage: 'Plugin uninstall failed',
        });
      }
    },
  );

  fastify.get('/runtime-info', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }
    return reply.send(await getPluginRuntimeInfo());
  });

  fastify.post<{ Params: { name: string } }>('/:name/enable', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }

    const { name } = req.params;
    const plugin = engine.pluginManager.getSnapshot().plugins.find((entry) => entry.name === name);
    if (!plugin) {
      return reply.status(404).send({ error: 'plugin not found' });
    }
    if (plugin.type !== 'utility') {
      return reply.status(400).send({ error: 'strategy plugin cannot be enabled or disabled' });
    }
    const existing = configManager.getPluginsConfig().configs?.[name] ?? { enabled: false, settings: {} };
    engine.pluginManager.setPluginEnabled(name, true);
    await configManager.setPluginConfig(name, {
      enabled: true,
      settings: existing.settings ?? {},
    });
    logger.info(`Plugin enabled: ${name}`);
    return reply.send({ success: true });
  });

  fastify.post<{ Params: { name: string } }>('/:name/disable', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }

    const { name } = req.params;
    const plugin = engine.pluginManager.getSnapshot().plugins.find((entry) => entry.name === name);
    if (!plugin) {
      return reply.status(404).send({ error: 'plugin not found' });
    }
    if (plugin.type !== 'utility') {
      return reply.status(400).send({ error: 'strategy plugin cannot be enabled or disabled' });
    }
    engine.pluginManager.setPluginEnabled(name, false);
    const existing = configManager.getPluginsConfig().configs?.[name] ?? { enabled: false, settings: {} };
    await configManager.setPluginConfig(name, { ...existing, enabled: false });
    logger.info(`Plugin disabled: ${name}`);
    return reply.send({ success: true });
  });

  fastify.get<{ Params: { name: string } }>('/:name/settings', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }

    const { name } = req.params;
    const settings = getResolvedGlobalSettings(name);
    return reply.send({ settings });
  });

  fastify.put<{ Params: { name: string }; Body: { settings: Record<string, unknown> } }>(
    '/:name/settings',
    async (req, reply) => {
      if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
        return;
      }

      const { name } = req.params;
      const { settings } = req.body ?? {};
      if (!settings || typeof settings !== 'object') {
        return reply.status(400).send({ error: 'settings must be an object' });
      }
      engine.pluginManager.setPluginSettings(name, settings);
      const existing = configManager.getPluginsConfig().configs?.[name] ?? { enabled: false, settings: {} };
      await configManager.setPluginConfig(name, { ...existing, settings });
      logger.info(`Plugin global settings updated: ${name}`);
      return reply.send({ success: true });
    },
  );

  fastify.get<{ Params: { name: string; operatorId: string } }>(
    '/:name/operator/:operatorId/settings',
    async (req, reply) => {
      const { name, operatorId } = req.params;
      if (!await requireOperatorBindingAccess(fastify, req, reply, operatorId)) {
        return;
      }
      const settings = engine.pluginManager.getOperatorPluginSettings(operatorId, name);
      return reply.send({ settings });
    },
  );

  fastify.get<{ Params: { operatorId: string } }>(
    '/operators/:operatorId',
    async (req, reply) => {
      const { operatorId } = req.params;
      if (!await requireOperatorBindingAccess(fastify, req, reply, operatorId)) {
        return;
      }

      const pluginSnapshot = engine.pluginManager.getSnapshot();
      const runtimeState = engine.pluginManager.getOperatorRuntimeStatus(operatorId);
      const operatorSettings = configManager.getPluginsConfig().operatorSettings?.[operatorId] ?? {};

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

  fastify.put<{
    Params: { name: string; operatorId: string };
    Body: { settings: Record<string, unknown> };
  }>(
    '/:name/operator/:operatorId/settings',
    async (req, reply) => {
      const { name, operatorId } = req.params;
      if (!await requireOperatorBindingAccess(fastify, req, reply, operatorId)) {
        return;
      }

      const { settings } = req.body ?? {};
      if (!settings || typeof settings !== 'object') {
        return reply.status(400).send({ error: 'settings must be an object' });
      }
      const mergedSettings = engine.pluginManager.setOperatorPluginSettings(operatorId, name, settings);
      await configManager.setOperatorPluginSettings(operatorId, name, mergedSettings);
      logger.info(`Plugin operator settings updated: plugin=${name}, operator=${operatorId}`);
      return reply.send({ success: true });
    },
  );

  fastify.post('/reload', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }
    await engine.pluginManager.reloadPlugins();
    logger.info('All plugins reloaded');
    return reply.send({ success: true });
  });

  fastify.post<{ Params: { name: string } }>('/:name/reload', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }
    const { name } = req.params;
    await engine.pluginManager.reloadPlugin(name);
    logger.info(`Plugin reloaded: ${name}`);
    return reply.send({ success: true });
  });

  fastify.post('/rescan', async (req, reply) => {
    if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
      return;
    }
    await engine.pluginManager.rescanPlugins();
    logger.info('Plugins rescanned');
    return reply.send({ success: true });
  });

  fastify.put<{ Params: { id: string }; Body: { pluginName: string } }>(
    '/operators/:id/strategy',
    async (req, reply) => {
      if (!await requireMinimumRole(fastify, req, reply, UserRole.ADMIN)) {
        return;
      }

      const { id } = req.params;
      const { pluginName } = req.body ?? {};
      if (!pluginName) {
        return reply.status(400).send({ error: 'pluginName is required' });
      }
      engine.pluginManager.setOperatorStrategy(id, pluginName);
      await configManager.setOperatorStrategy(id, pluginName);
      logger.info(`Operator strategy set: operator=${id}, plugin=${pluginName}`);
      return reply.send({ success: true });
    },
  );

  // ===== Plugin UI: static files, CSS tokens, bridge SDK, invoke =====

  registerPluginUIRoutes(fastify, engine);

  // ===== Logbook sync provider endpoints =====

  fastify.get('/sync-providers', async (req, reply) => {
    const user = await requireMinimumRole(fastify, req, reply, UserRole.OPERATOR);
    if (!user) {
      return;
    }
    const scope = user.role === UserRole.ADMIN ? 'admin' : 'operator';
    return reply.send(engine.pluginManager.logbookSyncHost.getProviders(scope));
  });

  fastify.get<{ Querystring: { callsign?: string } }>('/sync-providers/configured', async (req, reply) => {
    const callsign = (req.query as Record<string, string>).callsign ?? '';
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign query parameter is required' });
    }
    const user = await requireCallsignBindingAccess(fastify, req, reply, callsign);
    if (!user) {
      return;
    }
    const visibleProviders = engine.pluginManager.logbookSyncHost.getProviders(
      user.role === UserRole.ADMIN ? 'admin' : 'operator',
    );
    const configured = engine.pluginManager.logbookSyncHost.getConfiguredStatus(callsign);
    const providers = Object.fromEntries(
      visibleProviders.map((provider) => [provider.id, configured[provider.id] ?? false]),
    );
    return reply.send({ providers });
  });

  fastify.post<{
    Params: { providerId: string };
    Body: { callsign: string };
  }>('/sync-providers/:providerId/test-connection', async (req, reply) => {
    const { providerId } = req.params;
    const { callsign } = req.body ?? {};
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign is required' });
    }
    const provider = engine.pluginManager.logbookSyncHost.getProviderInfo(providerId);
    if (!provider) {
      return reply.status(404).send({ error: 'provider not found' });
    }
    if (!(provider.accessScope === 'operator'
      ? await requireCallsignBindingAccess(fastify, req, reply, callsign)
      : await requireMinimumRole(fastify, req, reply, UserRole.ADMIN))) {
      return;
    }
    const result = await engine.pluginManager.logbookSyncHost.testConnection(providerId, callsign);
    return reply.send(result);
  });

  fastify.post<{
    Params: { providerId: string };
    Body: { callsign: string };
  }>('/sync-providers/:providerId/upload-preflight', async (req, reply) => {
    const { providerId } = req.params;
    const { callsign } = req.body ?? {};
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign is required' });
    }
    const provider = engine.pluginManager.logbookSyncHost.getProviderInfo(providerId);
    if (!provider) {
      return reply.status(404).send({ error: 'provider not found' });
    }
    if (!(provider.accessScope === 'operator'
      ? await requireCallsignBindingAccess(fastify, req, reply, callsign)
      : await requireMinimumRole(fastify, req, reply, UserRole.ADMIN))) {
      return;
    }

    try {
      const result = await engine.pluginManager.logbookSyncHost.getUploadPreflight(providerId, callsign);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload preflight failed';
      logger.error(`Sync upload preflight failed: provider=${providerId}`, err);
      return reply.status(500).send({ error: message });
    }
  });

  fastify.post<{
    Params: { providerId: string };
    Body: { callsign: string };
  }>('/sync-providers/:providerId/upload', async (req, reply) => {
    const { providerId } = req.params;
    const { callsign } = req.body ?? {};
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign is required' });
    }
    const provider = engine.pluginManager.logbookSyncHost.getProviderInfo(providerId);
    if (!provider) {
      return reply.status(404).send({ error: 'provider not found' });
    }
    if (!(provider.accessScope === 'operator'
      ? await requireCallsignBindingAccess(fastify, req, reply, callsign)
      : await requireMinimumRole(fastify, req, reply, UserRole.ADMIN))) {
      return;
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

  fastify.post<{
    Params: { providerId: string };
    Body: { callsign: string; since?: number };
  }>('/sync-providers/:providerId/download', async (req, reply) => {
    const { providerId } = req.params;
    const { callsign, since } = req.body ?? {};
    if (!callsign) {
      return reply.status(400).send({ error: 'callsign is required' });
    }
    const provider = engine.pluginManager.logbookSyncHost.getProviderInfo(providerId);
    if (!provider) {
      return reply.status(404).send({ error: 'provider not found' });
    }
    if (!(provider.accessScope === 'operator'
      ? await requireCallsignBindingAccess(fastify, req, reply, callsign)
      : await requireMinimumRole(fastify, req, reply, UserRole.ADMIN))) {
      return;
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

function injectIntoHTML(html: string, bootstrapScript?: string): string {
  const injection = [TOKEN_LINK, bootstrapScript, BRIDGE_SCRIPT]
    .filter((value): value is string => Boolean(value))
    .join('\n');
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) {
    return html.slice(0, headClose) + injection + '\n' + html.slice(headClose);
  }
  return injection + '\n' + html;
}

function getSessionPayloadResource(data: unknown): PluginPageBoundResource | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.callsign === 'string' && record.callsign.trim()) {
    return { kind: 'callsign', value: record.callsign.trim() };
  }
  if (typeof record.operatorId === 'string' && record.operatorId.trim()) {
    return { kind: 'operator', value: record.operatorId.trim() };
  }
  return null;
}

function getPayloadResourceForPage(
  engine: DigitalRadioEngine,
  pluginName: string,
  pageId: string,
  data: unknown,
): PluginPageBoundResource | null {
  const page = getPluginPageDescriptor(engine, pluginName, pageId);
  return page ? getPageBindingValue(page, data) : null;
}

function sessionResourceMatches(
  sessionResource: PluginPageBoundResource | undefined,
  payloadResource: PluginPageBoundResource | null,
): boolean {
  if (!payloadResource) {
    return true;
  }
  if (!sessionResource) {
    return false;
  }
  if (sessionResource.kind !== payloadResource.kind) {
    return false;
  }
  if (sessionResource.kind === 'callsign') {
    return normalizeCallsign(sessionResource.value) === normalizeCallsign(payloadResource.value);
  }
  return sessionResource.value === payloadResource.value;
}

async function resolveValidatedPageSession(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  engine: DigitalRadioEngine,
  pluginName: string,
  pageId: string,
  pageSessionId: string,
  payloadResource?: PluginPageBoundResource | null,
): Promise<{
  page: PluginUIPageDescriptor;
  session: PluginPageSession;
  user: RuntimeAuthUser;
  requestContext: {
    pageSessionId: string;
    user: ReturnType<typeof toPluginRequestUser>;
    resource?: PluginPageBoundResource;
    instanceTarget: PluginPageSession['instanceTarget'];
    files: ScopedPluginFileStoreProvider;
    page: {
      sessionId: string;
      pageId: string;
      resource?: PluginPageBoundResource;
      push(action: string, data?: unknown): void;
    };
  };
} | null> {
  const page = getPluginPageDescriptor(engine, pluginName, pageId);
  if (!page) {
    await reply.status(404).send({ error: 'Plugin page not found' });
    return null;
  }

  const user = await requirePageAccess(fastify, request, reply, page);
  if (!user) {
    return null;
  }

  const session = engine.pluginManager.getPluginPageSession(pageSessionId);
  if (!session || session.pluginName !== pluginName || session.pageId !== pageId) {
    await reply.status(401).send({ error: 'Page session is invalid or expired' });
    return null;
  }

  if (session.accessScope !== (page.accessScope ?? 'admin')) {
    await reply.status(403).send({ error: 'Page session scope mismatch' });
    return null;
  }

  if (session.instanceTarget.kind === 'operator' && !userHasOperatorAccess(user, session.instanceTarget.operatorId)) {
    await reply.status(403).send({
      error: 'No operator access for page instance',
      userMessage: 'You do not have access to this operator',
    });
    return null;
  }

  if (session.resource?.kind === 'callsign' && !userHasCallsignAccess(user, session.resource.value)) {
    await reply.status(403).send({ error: 'No permission to access this callsign' });
    return null;
  }

  if (session.resource?.kind === 'operator' && !userHasOperatorAccess(user, session.resource.value)) {
    await reply.status(403).send({ error: 'No operator access', userMessage: 'You do not have access to this operator' });
    return null;
  }

  if (!sessionResourceMatches(session.resource, payloadResource ?? null)) {
    await reply.status(403).send({ error: 'Payload resource does not match page session binding' });
    return null;
  }

  const activeSession = engine.pluginManager.touchPluginPageSession(pageSessionId) ?? session;
  const pageFiles = createPageScopedFileStore(engine, pluginName, activeSession.pageId, activeSession);

  return {
    page,
    session: activeSession,
    user,
    requestContext: {
      pageSessionId: activeSession.sessionId,
      user: toPluginRequestUser(user),
      resource: activeSession.resource,
      instanceTarget: activeSession.instanceTarget,
      files: pageFiles,
      page: {
        sessionId: activeSession.sessionId,
        pageId: activeSession.pageId,
        resource: activeSession.resource,
        push(action: string, data?: unknown) {
          engine.pluginManager.pushPluginPageSession(
            pluginName,
            activeSession.pageId,
            activeSession.sessionId,
            action,
            data,
          );
        },
      },
    },
  };
}

function createPageScopedFileStore(
  engine: DigitalRadioEngine,
  pluginName: string,
  pageId: string,
  session: PluginPageSession,
): ScopedPluginFileStoreProvider {
  const fileRoot = path.join(engine.pluginManager.getPluginStorageDir(pluginName), 'files');
  const backingStore = new PluginFileStoreProvider(fileRoot);

  return new ScopedPluginFileStoreProvider(
    backingStore,
    getPluginPageFileScopePath(pageId, {
      instanceTarget: session.instanceTarget,
      resource: session.resource,
    }),
  );
}

// ===== Route registration =====

function registerPluginUIRoutes(fastify: FastifyInstance, engine: DigitalRadioEngine): void {
  const pageStoreProviders = new Map<string, Promise<PluginStorageProvider>>();

  const getPageStoreProvider = async (storePath: string): Promise<PluginStorageProvider> => {
    const existing = pageStoreProviders.get(storePath);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const provider = new PluginStorageProvider(storePath);
      await provider.init();
      return provider;
    })();
    pageStoreProviders.set(storePath, pending);

    try {
      return await pending;
    } catch (err) {
      pageStoreProviders.delete(storePath);
      throw err;
    }
  };

  // GET /api/plugins/_bridge/tokens.css
  fastify.get('/_bridge/tokens.css', async (req: FastifyRequest, reply: FastifyReply) => {
    const theme = (req.query as Record<string, string>).theme === 'light' ? 'light' : 'dark';
    return reply.type('text/css; charset=utf-8').send(generateCSSTokens(theme));
  });

  // GET /api/plugins/_bridge/bridge.js
  fastify.get('/_bridge/bridge.js', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.type('application/javascript; charset=utf-8').send(getPluginBridgeSdkScript());
  });

  // GET /api/plugins/:name/ui/* — serve plugin static files
  fastify.get<{ Params: { name: string; '*': string } }>(
    '/:name/ui/*',
    async (req, reply) => {
      const { name } = req.params;
      let filePath = req.params['*'] || 'index.html';

      const loaded = engine.pluginManager.getLoadedPlugin(name);
      if (!loaded) {
        return reply.status(404).send({ error: 'Plugin not found' });
      }

      if (!loaded.dirPath) {
        return reply.status(404).send({ error: 'Plugin has no static file directory' });
      }

      let declaredPage = loaded.definition.ui?.pages?.find((page) => page.entry === filePath) ?? null;
      const isHtmlFile = path.extname(filePath).toLowerCase() === '.html';
      if (isHtmlFile && !declaredPage) {
        const pageId = path.basename(filePath, '.html');
        const pageById = loaded.definition.ui?.pages?.find((page) => page.id === pageId) ?? null;
        if (pageById) {
          declaredPage = pageById;
          filePath = pageById.entry;
        }
      }
      if (isHtmlFile && !declaredPage) {
        return reply.status(404).send({ error: 'Plugin page not found' });
      }

      let bootstrapScript: string | undefined;
      if (declaredPage) {
        const user = await requirePageAccess(fastify, req, reply, declaredPage, true);
        if (!user) {
          return;
        }

        const instanceTarget = getPluginInstanceTarget(engine, name, req.query);
        const loadedInstanceScope = loaded.definition.instanceScope ?? 'operator';
        if (loadedInstanceScope === 'operator') {
          if (!instanceTarget || instanceTarget.kind !== 'operator') {
            return reply.status(400).send({ error: 'operatorId query parameter is required' });
          }
          if (!await requireOperatorBindingAccess(
            fastify,
            req,
            reply,
            instanceTarget.operatorId,
            true,
          )) {
            return;
          }
        }

        const binding = getPageBindingValue(declaredPage, req.query);
        if (declaredPage.resourceBinding === 'callsign') {
          if (!binding) {
            return reply.status(400).send({ error: 'callsign query parameter is required' });
          }
          if (!await requireCallsignBindingAccess(fastify, req, reply, binding.value, true)) {
            return;
          }
        }
        if (declaredPage.resourceBinding === 'operator') {
          if (!binding) {
            return reply.status(400).send({ error: 'operatorId query parameter is required' });
          }
          if (!await requireOperatorBindingAccess(fastify, req, reply, binding.value, true)) {
            return;
          }
        }

        const session = engine.pluginManager.createPluginPageSession({
          pluginName: name,
          pageId: declaredPage.id,
          accessScope: declaredPage.accessScope ?? 'admin',
          instanceTarget: instanceTarget ?? { kind: 'global' },
          resource: binding ?? undefined,
        });
        logger.debug('Plugin page session created', {
          pluginName: name,
          pageId: declaredPage.id,
          sessionId: session.sessionId,
          userRole: user.role,
          instanceTarget: session.instanceTarget,
          resource: binding,
        });
        bootstrapScript = createSessionBootstrapScript(session.sessionId);
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
          return reply.type(mime).send(injectIntoHTML(content.toString('utf-8'), bootstrapScript));
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
    Body: { pageId: string; pageSessionId: string; action: string; data?: unknown };
  }>(
    '/:name/ui-invoke',
    async (req, reply) => {
      const { name } = req.params;
      const { pageId, pageSessionId, action, data } = req.body ?? {};

      if (!pageId || !pageSessionId || !action) {
        return reply.status(400).send({ error: 'pageId, pageSessionId and action are required' });
      }

      const pageContext = await resolveValidatedPageSession(
        fastify,
        req,
        reply,
        engine,
        name,
        pageId,
        pageSessionId,
        getPayloadResourceForPage(engine, name, pageId, data),
      );
      if (!pageContext) {
        return;
      }

      try {
        const result = await engine.pluginManager.invokePluginPageHandler(
          name,
          pageId,
          action,
          data,
          pageContext.requestContext,
        );
        return reply.send({ result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.warn(`Plugin UI invoke failed: plugin=${name}, action=${action}`, { error: message });
        return reply.status(500).send({ error: message });
      }
    },
  );

  fastify.post<{
    Params: { name: string };
    Body: { pageId: string; pageSessionId: string };
  }>(
    '/:name/ui-session/heartbeat',
    async (req, reply) => {
      const { name } = req.params;
      const { pageId, pageSessionId } = req.body ?? {};

      if (!pageId || !pageSessionId) {
        return reply.status(400).send({ error: 'pageId and pageSessionId are required' });
      }

      const pageContext = await resolveValidatedPageSession(
        fastify,
        req,
        reply,
        engine,
        name,
        pageId,
        pageSessionId,
      );
      if (!pageContext) {
        return;
      }

      return reply.send({ result: true });
    },
  );

  fastify.post<{
    Params: { name: string };
    Body: {
      pageId: string;
      pageSessionId: string;
      type?: string;
      key: string;
      value?: unknown;
      callsign?: string;
      operatorId?: string;
    };
  }>(
    '/:name/ui-store',
    async (req, reply) => {
      const { name } = req.params;
      const { pageId, pageSessionId, key, type } = req.body ?? {};
      if (!pageId || !pageSessionId || !key || !type) {
        return reply.status(400).send({ error: 'pageId, pageSessionId, type and key are required' });
      }

      const sessionContext = await resolveValidatedPageSession(
        fastify,
        req,
        reply,
        engine,
        name,
        pageId,
        pageSessionId,
        getSessionPayloadResource(req.body),
      );
      if (!sessionContext) {
        return;
      }

      const storePath = path.join(
        engine.pluginManager.getPluginStorageDir(name),
        getPluginPageStorePath(pageId, {
          instanceTarget: sessionContext.session.instanceTarget,
          resource: sessionContext.session.resource,
        }),
      );
      const store = await getPageStoreProvider(storePath);

      if (type === 'tx5dr:store:get') {
        return reply.send({ result: store.get(key, null) });
      }
      if (type === 'tx5dr:store:set') {
        store.set(key, req.body?.value);
        await store.flush();
        return reply.send({ result: true });
      }
      if (type === 'tx5dr:store:delete') {
        store.delete(key);
        await store.flush();
        return reply.send({ result: true });
      }

      return reply.status(400).send({ error: 'Unsupported ui-store operation' });
    },
  );

  fastify.post<{
    Params: { name: string };
    Body: {
      pageId: string;
      pageSessionId: string;
      path?: string;
      prefix?: string;
      data?: string;
      callsign?: string;
      operatorId?: string;
      type?: string;
    };
  }>(
    '/:name/ui-files',
    async (req, reply) => {
      const { name } = req.params;
      const { pageId, pageSessionId, path: filePath, prefix, data, type } = req.body ?? {};
      if (!pageId || !pageSessionId || !type) {
        return reply.status(400).send({ error: 'pageId, pageSessionId and type are required' });
      }

      const sessionContext = await resolveValidatedPageSession(
        fastify,
        req,
        reply,
        engine,
        name,
        pageId,
        pageSessionId,
        getSessionPayloadResource(req.body),
      );
      if (!sessionContext) {
        return;
      }

      const scopedStore = sessionContext.requestContext.files;

      if (type === 'tx5dr:file:upload') {
        if (!filePath || typeof data !== 'string') {
          return reply.status(400).send({ error: 'path and data are required for upload' });
        }
        await scopedStore.write(filePath, Buffer.from(data, 'base64'));
        return reply.send({ result: filePath });
      }

      if (type === 'tx5dr:file:read') {
        if (!filePath) {
          return reply.status(400).send({ error: 'path is required for read' });
        }
        const content = await scopedStore.read(filePath);
        return reply.send({ result: content ? content.toString('base64') : null });
      }

      if (type === 'tx5dr:file:delete') {
        if (!filePath) {
          return reply.status(400).send({ error: 'path is required for delete' });
        }
        return reply.send({ result: await scopedStore.delete(filePath) });
      }

      if (type === 'tx5dr:file:list') {
        return reply.send({ result: await scopedStore.list(prefix) });
      }

      return reply.status(400).send({ error: 'Unsupported ui-files operation' });
    },
  );
}
