import { HealthResponseSchema, type HealthResponse } from '@plus-fabric/shared';
import type { FastifyPluginAsync } from 'fastify';

type SystemRouteOptions = {
  startedAt: number;
};

export const registerSystemRoutes: FastifyPluginAsync<SystemRouteOptions> = async (
  app,
  options,
) => {
  app.get('/health', async (): Promise<HealthResponse> =>
    HealthResponseSchema.parse({
      status: 'ok',
      service: 'plus-fabric-control-plane',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - options.startedAt) / 1000),
    }),
  );
};
