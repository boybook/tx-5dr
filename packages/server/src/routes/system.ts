import { FastifyInstance } from 'fastify';
import os from 'node:os';

/**
 * 系统信息路由
 */
export async function systemRoutes(fastify: FastifyInstance) {

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
}
