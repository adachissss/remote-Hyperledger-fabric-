import {
  ContractExecutionRequestSchema,
  CreateChaincodeDeploymentRequestSchema,
  JobSchema,
  NetworkIdSchema,
} from '@plus-fabric/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { JobServiceError } from '../jobs/job-service.js';
import { NetworkImportError } from '../networks/network-import-service.js';
import { ChaincodeService, ChaincodeServiceError } from './chaincode-service.js';

type ChaincodeRouteOptions = {
  chaincodeService: ChaincodeService;
};

export const registerChaincodeRoutes: FastifyPluginAsync<ChaincodeRouteOptions> = async (
  app,
  options,
) => {
  app.get('/:networkId/chaincodes', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;
    try {
      return await options.chaincodeService.getInventory(networkId);
    } catch (error) {
      return sendChaincodeError(error, reply);
    }
  });

  app.post('/:networkId/chaincodes/deployments', async (request, reply) => {
    const networkId = parseNetworkId(request.params, reply);
    if (!networkId) return;
    const body = CreateChaincodeDeploymentRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_chaincode_deployment',
        message: 'The chaincode deployment request is invalid.',
        issues: body.error.issues,
      });
    }
    try {
      const job = await options.chaincodeService.createDeployment(networkId, body.data);
      return reply.code(202).send(JobSchema.parse(job));
    } catch (error) {
      return sendChaincodeError(error, reply);
    }
  });

  app.post('/:networkId/contracts/evaluate', async (request, reply) => {
    return executeContract('evaluate', request.params, request.body, reply, options.chaincodeService);
  });

  app.post('/:networkId/contracts/submit', async (request, reply) => {
    return executeContract('submit', request.params, request.body, reply, options.chaincodeService);
  });
};

async function executeContract(
  mode: 'evaluate' | 'submit',
  params: unknown,
  body: unknown,
  reply: FastifyReply,
  service: ChaincodeService,
) {
  const networkId = parseNetworkId(params, reply);
  if (!networkId) return;
  const request = ContractExecutionRequestSchema.safeParse(body);
  if (!request.success) {
    return reply.code(400).send({
      error: 'invalid_contract_request',
      message: 'The contract execution request is invalid.',
      issues: request.error.issues,
    });
  }
  try {
    return await service.execute(networkId, mode, request.data);
  } catch (error) {
    return sendChaincodeError(error, reply);
  }
}

function parseNetworkId(params: unknown, reply: FastifyReply): string | null {
  const networkId = NetworkIdSchema.safeParse((params as { networkId?: unknown }).networkId);
  if (networkId.success) return networkId.data;
  reply.code(400).send({ error: 'invalid_network_id', message: 'The network id is invalid.' });
  return null;
}

function sendChaincodeError(error: unknown, reply: FastifyReply) {
  if (
    error instanceof ChaincodeServiceError ||
    error instanceof JobServiceError ||
    error instanceof NetworkImportError
  ) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}
