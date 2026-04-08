import type { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginRoutes');

/**
 * 插件管理 REST API
 *
 * GET  /api/plugins                               — 列出所有插件及状态
 * POST /api/plugins/:name/enable                 — 启用插件
 * POST /api/plugins/:name/disable                — 禁用插件
 * POST /api/plugins/:name/reload                 — 热重载单个插件
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
}
