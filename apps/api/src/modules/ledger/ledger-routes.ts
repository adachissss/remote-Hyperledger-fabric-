import {
  FabricBlockNumberSchema,
  FabricChannelNameSchema,
  NetworkIdSchema,
} from '@plus-fabric/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { NetworkImportError } from '../networks/network-import-service.js';
import { LedgerService, LedgerServiceError } from './ledger-service.js';

type LedgerRouteOptions = {
  ledgerService: LedgerService;
};

const BlockListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
  before: FabricBlockNumberSchema.optional(),
});

export const registerLedgerRoutes: FastifyPluginAsync<LedgerRouteOptions> = async (
  app,
  options,
) => {
  app.get('/:networkId/channels', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;
    try {
      return await options.ledgerService.listChannels(networkId);
    } catch (error) {
      return sendLedgerError(error, reply);
    }
  });

  app.get('/:networkId/channels/:channelName/blocks', async (request, reply) => {
    const params = parseChannelParams(request.params, reply);
    if (!params) return;
    const query = BlockListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_block_query',
        message: 'The block list query is invalid.',
        issues: query.error.issues,
      });
    }

    try {
      return await options.ledgerService.listBlocks(
        params.networkId,
        params.channelName,
        query.data.limit,
        query.data.before,
      );
    } catch (error) {
      return sendLedgerError(error, reply);
    }
  });

  app.get('/:networkId/channels/:channelName/blocks/:blockNumber', async (request, reply) => {
    const params = parseChannelParams(request.params, reply);
    if (!params) return;
    const blockNumber = FabricBlockNumberSchema.safeParse(
      (request.params as { blockNumber?: unknown }).blockNumber,
    );
    if (!blockNumber.success) {
      return reply.code(400).send({
        error: 'invalid_block_number',
        message: 'The Fabric block number is invalid.',
      });
    }

    try {
      return await options.ledgerService.getBlock(
        params.networkId,
        params.channelName,
        blockNumber.data,
      );
    } catch (error) {
      return sendLedgerError(error, reply);
    }
  });
};

function parseNetworkId(params: unknown, reply: FastifyReply): string | null {
  const networkId = NetworkIdSchema.safeParse((params as { networkId?: unknown }).networkId);
  if (networkId.success) return networkId.data;
  reply.code(400).send({ error: 'invalid_network_id', message: 'The network id is invalid.' });
  return null;
}

function parseChannelParams(
  params: unknown,
  reply: FastifyReply,
): { networkId: string; channelName: string } | null {
  const networkId = parseNetworkId(params, reply);
  if (!networkId) return null;
  const channelName = FabricChannelNameSchema.safeParse(
    (params as { channelName?: unknown }).channelName,
  );
  if (!channelName.success) {
    reply.code(400).send({
      error: 'invalid_channel_name',
      message: 'The Fabric channel name is invalid.',
    });
    return null;
  }
  return { networkId, channelName: channelName.data };
}

function sendLedgerError(error: unknown, reply: FastifyReply) {
  if (error instanceof LedgerServiceError || error instanceof NetworkImportError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}
