import { exampleModeCapabilities } from './examples.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT) || 4000;

async function start() {
  try {
    const server = await createServer();
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 TX-5DR server running on http://localhost:${PORT}`);
    exampleModeCapabilities();
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

start(); 