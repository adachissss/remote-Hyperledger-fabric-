import {
  ImportNetworkRequestSchema,
  NetworkIdSchema,
  NetworkListResponseSchema,
  type NetworkListResponse,
} from '@plus-fabric/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { NetworkImportError, type NetworkImportService } from './network-import-service.js';
import type { NetworkRegistry } from './network-registry.js';

type NetworkRouteOptions = {
  networkRegistry: NetworkRegistry;
  networkImportService: NetworkImportService;
};

export const registerNetworkRoutes: FastifyPluginAsync<NetworkRouteOptions> = async (
  app,
  options,
) => {
  app.get('/', async (): Promise<NetworkListResponse> => {
    const items = await options.networkRegistry.list();
    return NetworkListResponseSchema.parse({ items, total: items.length });
  });

  app.post('/import', async (request, reply) => {
    const parsed = ImportNetworkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'The network import request is invalid.',
        issues: parsed.error.issues,
      });
    }

    try {
      const network = await options.networkImportService.import(parsed.data);
      return reply.code(201).send(network);
    } catch (error) {
      return sendNetworkError(error, reply);
    }
  });

  app.get('/:networkId/config', async (request, reply) => {
    const parsed = NetworkIdSchema.safeParse(
      (request.params as { networkId?: unknown }).networkId,
    );
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_network_id',
        message: 'The network id is invalid.',
      });
    }

    try {
      return await options.networkImportService.getConfig(parsed.data);
    } catch (error) {
      return sendNetworkError(error, reply);
    }
  });
};

function sendNetworkError(error: unknown, reply: FastifyReply) {
  if (error instanceof NetworkImportError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }

  throw error;
}
