import {
  ImportNetworkRequestSchema,
  NetworkIdSchema,
  NetworkListResponseSchema,
  NetworkNodeIdSchema,
  type NetworkListResponse,
} from '@plus-fabric/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { NetworkImportError, type NetworkImportService } from './network-import-service.js';
import type { NetworkObservatoryService } from './network-observatory-service.js';
import type { NetworkRegistry } from './network-registry.js';

type NetworkRouteOptions = {
  networkRegistry: NetworkRegistry;
  networkImportService: NetworkImportService;
  networkObservatoryService: NetworkObservatoryService;
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

  app.get('/:networkId/topology', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;

    try {
      return await options.networkObservatoryService.getTopology(networkId);
    } catch (error) {
      return sendNetworkError(error, reply);
    }
  });

  app.get('/:networkId/nodes', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;

    try {
      return await options.networkObservatoryService.getNodes(networkId);
    } catch (error) {
      return sendNetworkError(error, reply);
    }
  });

  app.get('/:networkId/nodes/:nodeId', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;

    const nodeId = NetworkNodeIdSchema.safeParse(
      (request.params as { nodeId?: unknown }).nodeId,
    );
    if (!nodeId.success) {
      return reply.code(400).send({
        error: 'invalid_node_id',
        message: 'The node id is invalid.',
      });
    }

    try {
      return await options.networkObservatoryService.getNode(networkId, nodeId.data);
    } catch (error) {
      return sendNetworkError(error, reply);
    }
  });
};

function parseNetworkId(params: unknown, reply: FastifyReply): string | null {
  const parsed = NetworkIdSchema.safeParse((params as { networkId?: unknown }).networkId);
  if (parsed.success) return parsed.data;

  reply.code(400).send({
    error: 'invalid_network_id',
    message: 'The network id is invalid.',
  });
  return null;
}

function sendNetworkError(error: unknown, reply: FastifyReply) {
  if (error instanceof NetworkImportError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }

  throw error;
}
