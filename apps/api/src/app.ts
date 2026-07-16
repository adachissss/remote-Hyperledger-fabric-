import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { DockerCliRuntime, type DockerRuntime } from './modules/networks/docker-runtime.js';
import { NetworkImportService } from './modules/networks/network-import-service.js';
import { NetworkObservatoryService } from './modules/networks/network-observatory-service.js';
import { createNetworkRegistry } from './modules/networks/network-registry.js';
import { registerNetworkRoutes } from './modules/networks/network-routes.js';
import { TcpServiceProbe, type ServiceProbe } from './modules/networks/service-probe.js';
import { registerSystemRoutes } from './modules/system/system-routes.js';

export type AppDependencies = {
  dockerRuntime?: DockerRuntime;
  serviceProbe?: ServiceProbe;
};

export async function buildApp(
  config: AppConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const startedAt = Date.now();
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  await app.register(cors, {
    origin: config.corsOrigins,
  });

  const networkRegistry = createNetworkRegistry(config.databasePath);
  const networkImportService = new NetworkImportService(
    networkRegistry,
    config.allowedNetworkRoots,
  );
  const networkObservatoryService = new NetworkObservatoryService(
    networkImportService,
    dependencies.dockerRuntime ?? new DockerCliRuntime(),
    dependencies.serviceProbe ?? new TcpServiceProbe(),
  );

  app.addHook('onClose', async () => {
    await networkRegistry.close();
  });

  await app.register(registerSystemRoutes, { prefix: '/api/v1/system', startedAt });
  await app.register(registerNetworkRoutes, {
    prefix: '/api/v1/networks',
    networkRegistry,
    networkImportService,
    networkObservatoryService,
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message: 'The requested control-plane resource does not exist.',
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ error }, 'request failed');
    return reply.code(500).send({
      error: 'internal_error',
      message: 'The control plane could not complete the request.',
    });
  });

  return app;
}
