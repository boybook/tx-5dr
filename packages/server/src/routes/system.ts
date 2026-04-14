import { FastifyInstance } from 'fastify';
import os from 'node:os';
import { SetClockOffsetRequestSchema } from '@tx5dr/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { requireAbility } from '../auth/authPlugin.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';

/**
 * 系统信息路由
 */
export async function systemRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();

  // 获取网络访问地址
  fastify.get('/network-info', async (_request, reply) => {
    const webPort = parseInt(process.env.WEB_PORT || '5173', 10);
    const interfaces = os.networkInterfaces();
    const addresses: { ip: string; url: string }[] = [];

    for (const [, nets] of Object.entries(interfaces)) {
      if (!nets) continue;
      for (const net of nets) {
        // 仅 IPv4、非 internal、非 link-local
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
          addresses.push({
            ip: net.address,
            url: `http://${net.address}:${webPort}`,
          });
        }
      }
    }

    return reply.send({
      addresses,
      hostname: os.hostname(),
      webPort,
    });
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
}
