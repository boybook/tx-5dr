import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { HamlibConfigSchema } from '@tx5dr/contracts';
import serialport from 'serialport';
const { SerialPort } = serialport;
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export async function radioRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const configManager = ConfigManager.getInstance();
  const radioManager = engine.getRadioManager();
  const freqManager = new FrequencyManager();

  fastify.get('/config', async (_req, reply) => {
    return reply.send({ success: true, config: configManager.getRadioConfig() });
  });

  fastify.post('/config', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    try {
      const config = HamlibConfigSchema.parse(req.body);
      await configManager.updateRadioConfig(config);
      if (engine.getStatus().isRunning) {
        await radioManager.applyConfig(config);
      }
      return reply.send({ success: true, config });
    } catch (err) {
      return reply.code(400).send({ success: false, message: (err as Error).message });
    }
  });

  fastify.get('/rigs', async (_req, reply) => {
    return reply.send({ rigs: PhysicalRadioManager.listSupportedRigs() });
  });

  fastify.get('/serial-ports', async (_req, reply) => {
    const ports = await SerialPort.list();
    return reply.send({ ports });
  });

  fastify.get('/frequencies', async (_req, reply) => {
    return reply.send({ presets: freqManager.getPresets() });
  });

  fastify.post('/test', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    const config = HamlibConfigSchema.parse(req.body);
    const tester = new PhysicalRadioManager();
    try {
      await tester.applyConfig(config);
      await tester.disconnect();
      return reply.send({ success: true });
    } catch (e) {
      return reply.code(400).send({ success: false, message: (e as Error).message });
    }
  });

  fastify.post('/test-ptt', async (_req, reply) => {
    try {
      await radioManager.setPTT(true);
      setTimeout(() => radioManager.setPTT(false), 500);
      return reply.send({ success: true });
    } catch (e) {
      return reply.code(400).send({ success: false, message: (e as Error).message });
    }
  });
}
