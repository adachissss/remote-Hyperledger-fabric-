import {
  CreateNetworkActionRequestSchema,
  CreateManagedNetworkRequestSchema,
  ImportNetworkRequestSchema,
  NetworkIdSchema,
  NetworkListResponseSchema,
  NetworkDiscoveryListResponseSchema,
  ImportNetworkDiscoveryRequestSchema,
  NetworkDiscoveryIdSchema,
  NetworkNodeIdSchema,
  NetworkScriptActionSchema,
  type NetworkListResponse,
} from '@plus-fabric/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { JobServiceError, type JobService } from '../jobs/job-service.js';
import { NetworkImportError, type NetworkImportService } from './network-import-service.js';
import {
  NetworkDiscoveryError,
  type NetworkDiscoveryService,
} from './network-discovery-service.js';
import type { NetworkObservatoryService } from './network-observatory-service.js';
import { ManagedNetworkError, type ManagedNetworkService } from './managed-network-service.js';
import type { NetworkRegistry } from './network-registry.js';

type NetworkRouteOptions = {
  networkRegistry: NetworkRegistry;
  networkImportService: NetworkImportService;
  networkObservatoryService: NetworkObservatoryService;
  jobService: JobService;
  managedNetworkService: ManagedNetworkService;
  networkDiscoveryService: NetworkDiscoveryService;
};

export const registerNetworkRoutes: FastifyPluginAsync<NetworkRouteOptions> = async (
  app,
  options,
) => {
  app.get('/', async (): Promise<NetworkListResponse> => {
    const items = await options.networkRegistry.list();
    return NetworkListResponseSchema.parse({ items, total: items.length });
  });

  app.get('/discoveries', async () => {
    return NetworkDiscoveryListResponseSchema.parse(
      await options.networkDiscoveryService.list(),
    );
  });

  app.post('/discoveries/:discoveryNetworkId/import', async (request, reply) => {
    const discoveryNetworkId = NetworkDiscoveryIdSchema.safeParse(
      (request.params as { discoveryNetworkId?: unknown }).discoveryNetworkId,
    );
    if (!discoveryNetworkId.success) {
      return reply.code(400).send({
        error: 'invalid_network_discovery_id',
        message: 'The network discovery id is invalid.',
      });
    }
    const body = ImportNetworkDiscoveryRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'The network discovery import request is invalid.',
        issues: body.error.issues,
      });
    }

    try {
      const manifest = await options.networkDiscoveryService.getImportableManifest(
        discoveryNetworkId.data,
      );
      return reply.code(201).send(
        await options.networkImportService.importDiscovered(manifest, body.data),
      );
    } catch (error) {
      return sendNetworkError(error, reply);
    }
  });

  app.post('/', async (request, reply) => {
    const parsed = CreateManagedNetworkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_managed_network',
        message: 'The managed network request is invalid.',
        issues: parsed.error.issues,
      });
    }
    try {
      return reply.code(201).send(await options.managedNetworkService.create(parsed.data));
    } catch (error) {
      return sendNetworkError(error, reply);
    }
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

  app.post('/:networkId/actions/:action', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;

    const action = NetworkScriptActionSchema.safeParse(
      (request.params as { action?: unknown }).action,
    );
    if (!action.success) {
      return reply.code(400).send({
        error: 'invalid_network_action',
        message: 'The network lifecycle action is invalid.',
      });
    }
    const body = CreateNetworkActionRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'The network action request is invalid.',
        issues: body.error.issues,
      });
    }

    try {
      const job = await options.jobService.createNetworkAction(
        networkId,
        action.data,
        body.data.confirmation,
      );
      return reply.code(202).send(job);
    } catch (error) {
      return sendNetworkError(error, reply);
    }
  });

  app.delete('/:networkId', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;

    const body = CreateNetworkActionRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'The network deletion request is invalid.',
        issues: body.error.issues,
      });
    }

    try {
      const job = await options.jobService.createNetworkDeletion(
        networkId,
        body.data.confirmation,
      );
      return reply.code(202).send(job);
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
  if (error instanceof NetworkDiscoveryError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof JobServiceError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof ManagedNetworkError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }

  throw error;
}
