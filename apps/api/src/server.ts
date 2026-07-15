import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

let app: FastifyInstance | undefined;

try {
  const config = loadConfig();
  app = await buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    app?.log.info({ signal }, 'shutting down control plane');
    await app?.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  if (app) {
    app.log.error(error, 'failed to start control plane');
    await app.close();
  } else {
    console.error('Failed to initialize control plane.', error);
  }
  process.exit(1);
}
