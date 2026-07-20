import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import {
  FabricCliChaincodeRuntime,
  type FabricChaincodeRuntime,
} from './modules/chaincodes/fabric-chaincode-runtime.js';
import { registerChaincodeRoutes } from './modules/chaincodes/chaincode-routes.js';
import { ChaincodeService } from './modules/chaincodes/chaincode-service.js';
import {
  FabricCliLedgerRuntime,
  type FabricLedgerRuntime,
} from './modules/ledger/fabric-ledger-runtime.js';
import { registerLedgerRoutes } from './modules/ledger/ledger-routes.js';
import { LedgerService } from './modules/ledger/ledger-service.js';
import { createJobRegistry } from './modules/jobs/job-registry.js';
import { registerJobRoutes } from './modules/jobs/job-routes.js';
import { JobService } from './modules/jobs/job-service.js';
import {
  NodeProcessRunner,
  type ProcessRunner,
} from './modules/jobs/process-runner.js';
import { DockerCliRuntime, type DockerRuntime } from './modules/networks/docker-runtime.js';
import {
  DockerCliManagedNamespaceProbe,
  ManagedNetworkService,
  type ManagedNamespaceProbe,
} from './modules/networks/managed-network-service.js';
import {
  ManagedPortPlanner,
  TcpHostPortProbe,
  type HostPortProbe,
} from './modules/networks/managed-port-planner.js';
import { NetworkImportService } from './modules/networks/network-import-service.js';
import { NetworkDiscoveryService } from './modules/networks/network-discovery-service.js';
import { NetworkObservatoryService } from './modules/networks/network-observatory-service.js';
import { createNetworkRegistry } from './modules/networks/network-registry.js';
import { registerNetworkRoutes } from './modules/networks/network-routes.js';
import { TcpServiceProbe, type ServiceProbe } from './modules/networks/service-probe.js';
import { registerSystemRoutes } from './modules/system/system-routes.js';

export type AppDependencies = {
  dockerRuntime?: DockerRuntime;
  serviceProbe?: ServiceProbe;
  processRunner?: ProcessRunner;
  ledgerRuntime?: FabricLedgerRuntime;
  chaincodeRuntime?: FabricChaincodeRuntime;
  hostPortProbe?: HostPortProbe;
  managedNamespaceProbe?: ManagedNamespaceProbe;
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
  const jobRegistry = createJobRegistry(config.databasePath);
  const networkImportService = new NetworkImportService(
    networkRegistry,
    config.allowedNetworkRoots,
    config.managedNetworkRoot,
  );
  const networkDiscoveryService = new NetworkDiscoveryService(
    networkRegistry,
    config.discoveryRoot,
  );
  const managedNetworkService = new ManagedNetworkService(
    networkRegistry,
    config.managedNetworkRoot,
    config.driverTemplateRoot,
    new ManagedPortPlanner(dependencies.hostPortProbe ?? new TcpHostPortProbe()),
    dependencies.managedNamespaceProbe ?? new DockerCliManagedNamespaceProbe(),
  );
  const networkObservatoryService = new NetworkObservatoryService(
    networkImportService,
    dependencies.dockerRuntime ?? new DockerCliRuntime(),
    dependencies.serviceProbe ?? new TcpServiceProbe(),
  );
  const jobService = new JobService(
    jobRegistry,
    networkRegistry,
    dependencies.processRunner ?? new NodeProcessRunner(),
    config.managedNetworkRoot,
    config.driverTemplateRoot,
  );
  await jobService.initialize();
  const ledgerRuntime = dependencies.ledgerRuntime ?? new FabricCliLedgerRuntime();
  const ledgerService = new LedgerService(
    networkRegistry,
    networkImportService,
    ledgerRuntime,
  );
  const chaincodeService = new ChaincodeService(
    networkRegistry,
    networkImportService,
    ledgerRuntime,
    dependencies.chaincodeRuntime ?? new FabricCliChaincodeRuntime(),
    jobService,
  );

  app.addHook('onClose', async () => {
    await jobService.close();
    await jobRegistry.close();
    await networkRegistry.close();
  });

  await app.register(registerSystemRoutes, { prefix: '/api/v1/system', startedAt });
  await app.register(registerJobRoutes, { prefix: '/api/v1/jobs', jobService });
  await app.register(registerLedgerRoutes, {
    prefix: '/api/v1/networks',
    ledgerService,
  });
  await app.register(registerChaincodeRoutes, {
    prefix: '/api/v1/networks',
    chaincodeService,
  });
  await app.register(registerNetworkRoutes, {
    prefix: '/api/v1/networks',
    networkRegistry,
    networkImportService,
    networkObservatoryService,
    jobService,
    managedNetworkService,
    networkDiscoveryService,
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
