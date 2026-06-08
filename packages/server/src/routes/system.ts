import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import {
  NtpServerListSettingsSchema,
  ServerCpuProfileStatusSchema,
  SetClockAutoApplyRequestSchema,
  SetClockOffsetRequestSchema,
  SystemLoggingSettingsSchema,
  UpdateNtpServerListRequestSchema,
  UpdateSystemLoggingSettingsSchema,
} from '@tx5dr/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { requireAbility } from '../auth/authPlugin.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { ServerCpuProfileManager } from '../services/ServerCpuProfileManager.js';
import { getSystemUpdateStatus } from '../services/UpdateStatusService.js';
import { tx5drPaths } from '../utils/app-paths.js';
import { getActiveLogLevel, setLogLevel } from '../utils/logger.js';
import { getNetworkAccessInfo } from '../utils/network-access.js';

/**
 * 系统信息路由
 */
export async function systemRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const configManager = ConfigManager.getInstance();

  async function getCpuProfileManager() {
    return ServerCpuProfileManager.create({ env: process.env });
  }

  async function getLoggingSettingsSnapshot() {
    return SystemLoggingSettingsSchema.parse({
      level: configManager.getConfig().logLevel,
      effectiveLevel: getActiveLogLevel(),
      logsDir: await tx5drPaths.getLogsDir(),
    });
  }

  fastify.get('/update-status', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    return reply.send(await getSystemUpdateStatus());
  });

  // 获取网络访问地址
  fastify.get('/network-info', async (request, reply) => {
    return reply.send(getNetworkAccessInfo({
      forwardedPort: request.headers['x-forwarded-port'],
    }));
  });

  fastify.get('/logging', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    return reply.send(await getLoggingSettingsSnapshot());
  });

  fastify.put('/logging', {
    schema: {
      body: zodToJsonSchema(UpdateSystemLoggingSettingsSchema),
    },
    preHandler: [requireAbility('manage', 'all')],
  }, async (request, reply) => {
    const { level } = UpdateSystemLoggingSettingsSchema.parse(request.body);
    await configManager.updateLogLevel(level);
    setLogLevel(level);
    process.env.LOG_LEVEL = level;
    return reply.send(await getLoggingSettingsSnapshot());
  });

  fastify.get('/clock', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    return reply.send(engine.getNtpCalibrationService().getStatus());
  });

  fastify.post('/clock/offset', {
    schema: {
      body: zodToJsonSchema(SetClockOffsetRequestSchema),
    },
    preHandler: [requireAbility('manage', 'all')],
  }, async (request, reply) => {
    const { offsetMs } = SetClockOffsetRequestSchema.parse(request.body);
    engine.getNtpCalibrationService().setAppliedOffset(offsetMs);
    return reply.send(engine.getNtpCalibrationService().getStatus());
  });

  fastify.post('/clock/measure', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    await engine.getNtpCalibrationService().triggerMeasurement();
    return reply.send(engine.getNtpCalibrationService().getStatus());
  });

  fastify.put('/clock/auto-apply', {
    schema: {
      body: zodToJsonSchema(SetClockAutoApplyRequestSchema),
    },
    preHandler: [requireAbility('manage', 'all')],
  }, async (request, reply) => {
    const { enabled } = SetClockAutoApplyRequestSchema.parse(request.body);
    await configManager.updateNtpAutoApplyOffset(enabled);
    engine.getNtpCalibrationService().setAutoApplyOffset(enabled);
    return reply.send(engine.getNtpCalibrationService().getStatus());
  });

  fastify.get('/clock/settings', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    return reply.send(NtpServerListSettingsSchema.parse({
      servers: configManager.getNtpServers(),
      defaultServers: configManager.getDefaultNtpServers(),
    }));
  });

  fastify.put('/clock/settings', {
    schema: {
      body: zodToJsonSchema(UpdateNtpServerListRequestSchema),
    },
    preHandler: [requireAbility('manage', 'all')],
  }, async (request, reply) => {
    const { servers } = UpdateNtpServerListRequestSchema.parse(request.body);
    await configManager.updateNtpServers(servers);
    engine.getNtpCalibrationService().setServers(servers);
    engine.getNtpCalibrationService().triggerMeasurement().catch((error) => {
      fastify.log.warn({ error }, 'NTP measurement refresh failed after settings update');
    });

    return reply.send(NtpServerListSettingsSchema.parse({
      servers: configManager.getNtpServers(),
      defaultServers: configManager.getDefaultNtpServers(),
    }));
  });

  fastify.get('/cpu-profile', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    const manager = await getCpuProfileManager();
    return reply.send(ServerCpuProfileStatusSchema.parse(await manager.getStatus()));
  });

  fastify.post('/cpu-profile/arm', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    const manager = await getCpuProfileManager();
    return reply.send(ServerCpuProfileStatusSchema.parse(await manager.armGuidedCapture()));
  });

  fastify.post('/cpu-profile/cancel', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    const manager = await getCpuProfileManager();
    return reply.send(ServerCpuProfileStatusSchema.parse(await manager.cancelGuidedCapture()));
  });

  fastify.post('/cpu-profile/dismiss', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    const manager = await getCpuProfileManager();
    return reply.send(ServerCpuProfileStatusSchema.parse(await manager.dismissResult()));
  });

  fastify.get('/cpu-profile/download', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (_request, reply) => {
    const manager = await getCpuProfileManager();
    const status = await manager.getStatus();

    if (status.state !== 'completed' || !status.profilePath) {
      return reply.code(404).send({
        error: {
          message: 'CPU profile file is not available yet',
          code: 'CPU_PROFILE_NOT_READY',
        },
      });
    }

    try {
      await access(status.profilePath);
    } catch {
      return reply.code(404).send({
        error: {
          message: 'CPU profile file is missing',
          code: 'CPU_PROFILE_MISSING',
        },
      });
    }

    const fileName = path.basename(status.profilePath);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    return reply.send(createReadStream(status.profilePath));
  });
}
