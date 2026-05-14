import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('server Device UI websocket wiring', () => {
  it('keeps the device websocket endpoint isolated from the browser WSServer client count path', async () => {
    const source = await readFile(join(process.cwd(), 'src/server.ts'), 'utf-8');
    const deviceWsRoute = extractRouteBody(source, '/api/device-ui/ws');
    const browserWsRoute = extractRouteBody(source, '/api/ws');

    expect(deviceWsRoute).toContain('deviceUiWsServer.acceptConnection(socket, req)');
    expect(deviceWsRoute).not.toContain('wsServer.addConnection');
    expect(deviceWsRoute).not.toContain('clientHandshake');
    expect(browserWsRoute).toContain('wsServer.addConnection(socket)');
  });
});

function extractRouteBody(source: string, route: string): string {
  const marker = `fastify.get('${route}'`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextRoute = source.indexOf('fastify.get(', start + marker.length);
  return source.slice(start, nextRoute === -1 ? source.length : nextRoute);
}
