import { NetworkListResponseSchema, type NetworkListResponse } from '@plus-fabric/shared';
import type { FastifyPluginAsync } from 'fastify';

import type { NetworkRegistry } from './network-registry.js';

type NetworkRouteOptions = {
  networkRegistry: NetworkRegistry;
};

export const registerNetworkRoutes: FastifyPluginAsync<NetworkRouteOptions> = async (
  app,
  options,
) => {
  app.get('/', async (): Promise<NetworkListResponse> => {
    const items = await options.networkRegistry.list();
    return NetworkListResponseSchema.parse({ items, total: items.length });
  });
};
