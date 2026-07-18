import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, cp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

import type { CreateManagedNetworkRequest, NetworkSummary } from '@plus-fabric/shared';
import { stringify as stringifyYaml } from 'yaml';

import {
  collectPublishedHostPorts,
  readFabricComposeConfig,
} from './fabric-compose-config.js';
import type { RegisteredNetwork } from './network-driver.js';
import {
  NetworkNamespaceConflictError,
  NetworkPortConflictError,
  NetworkRegistryConflictError,
  type NetworkRegistry,
} from './network-registry.js';
import {
  ManagedPortPlanError,
  ManagedPortPlanner,
  type ManagedNetworkPortPlan,
} from './managed-port-planner.js';

const execFileAsync = promisify(execFile);
const DEFAULT_FABRIC_VERSION = '2.4.1';
const DEFAULT_FABRIC_CA_VERSION = '1.5.3';

export interface ManagedNamespaceProbe {
  assertAvailable(dockerNetwork: string, containerNames: string[]): Promise<void>;
}

export class DockerCliManagedNamespaceProbe implements ManagedNamespaceProbe {
  async assertAvailable(dockerNetwork: string, containerNames: string[]): Promise<void> {
    if (await dockerObjectExists(['network', 'inspect', dockerNetwork])) {
      throw new ManagedNetworkError(
        'managed_docker_network_conflict',
        `Docker network "${dockerNetwork}" already exists.`,
        409,
      );
    }
    for (const containerName of containerNames) {
      if (await dockerObjectExists(['container', 'inspect', containerName])) {
        throw new ManagedNetworkError(
          'managed_container_name_conflict',
          `Docker container "${containerName}" already exists.`,
          409,
        );
      }
    }
  }
}

export class ManagedNetworkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ManagedNetworkError';
  }
}

export class ManagedNetworkService {
  private readonly creatingNetworkIds = new Set<string>();

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly managedNetworkRoot: string,
    private readonly driverTemplateRoot: string,
    private readonly portPlanner: ManagedPortPlanner,
    private readonly namespaceProbe: ManagedNamespaceProbe,
  ) {}

  async create(request: CreateManagedNetworkRequest): Promise<NetworkSummary> {
    if (this.creatingNetworkIds.has(request.id)) {
      throw new ManagedNetworkError(
        'network_exists',
        `A network with id "${request.id}" is already being created.`,
        409,
      );
    }
    this.creatingNetworkIds.add(request.id);
    try {
      return await this.createUnlocked(request);
    } finally {
      this.creatingNetworkIds.delete(request.id);
    }
  }

  private async createUnlocked(request: CreateManagedNetworkRequest): Promise<NetworkSummary> {
    if (await this.registry.get(request.id)) {
      throw new ManagedNetworkError(
        'network_exists',
        `A network with id "${request.id}" is already registered.`,
        409,
      );
    }

    const dockerNetwork = `pf-${request.id}`;
    const composeProject = `pf_${request.id.replaceAll('-', '_')}`;
    const envPrefix = `pf-${request.id}`;
    const fabricVersion = request.fabricVersion ?? DEFAULT_FABRIC_VERSION;
    const fabricCaVersion = request.fabricCaVersion ?? DEFAULT_FABRIC_CA_VERSION;
    const names = buildManagedNames(request, envPrefix);
    const registeredNamespaceConflict = (await this.registry.listRegistered()).find(
      (network) =>
        network.dockerNetwork === dockerNetwork || network.composeProject === composeProject,
    );
    if (registeredNamespaceConflict) {
      throw new ManagedNetworkError(
        'managed_namespace_conflict',
        `Network namespace is already registered by "${registeredNamespaceConflict.id}".`,
        409,
      );
    }
    await this.namespaceProbe.assertAvailable(dockerNetwork, names.containerNames);

    const reservedPorts = await this.collectReservedPorts();
    let portPlan: ManagedNetworkPortPlan;
    try {
      portPlan = await this.portPlanner.plan(request, reservedPorts);
    } catch (error) {
      if (error instanceof ManagedPortPlanError) {
        throw new ManagedNetworkError(error.code, error.message, 409);
      }
      throw error;
    }

    const workspaceRoot = path.join(this.managedNetworkRoot, request.id);
    const configPath = path.join(workspaceRoot, 'config', 'orgs.yaml');
    await this.createWorkspace(
      workspaceRoot,
      stringifyYaml(
        buildManagedConfig(
          request,
          dockerNetwork,
          composeProject,
          envPrefix,
          names,
          portPlan,
          fabricVersion,
          fabricCaVersion,
        ),
        { lineWidth: 0 },
      ),
      composeProject,
    );

    let snapshot;
    try {
      snapshot = readFabricComposeConfig(request.id, configPath);
    } catch (error) {
      await rm(workspaceRoot, { recursive: true, force: true });
      throw new ManagedNetworkError(
        'managed_config_generation_failed',
        error instanceof Error ? error.message : 'The generated network config is invalid.',
        500,
      );
    }

    const timestamp = new Date().toISOString();
    const network: RegisteredNetwork = {
      id: request.id,
      displayName: request.displayName,
      driver: 'fabric-compose',
      managementMode: 'managed',
      workspaceRoot,
      configPath,
      dockerNetwork,
      composeProject,
      fabricVersion,
      fabricCaVersion,
      organizationCount: snapshot.organizationCount,
      channelCount: snapshot.channelCount,
      nodeCount: snapshot.nodeCount,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.registry.create(network, portPlan.reservedPorts);
    } catch (error) {
      await rm(workspaceRoot, { recursive: true, force: true });
      if (error instanceof NetworkRegistryConflictError) {
        throw new ManagedNetworkError('network_exists', error.message, 409);
      }
      if (error instanceof NetworkPortConflictError) {
        throw new ManagedNetworkError('managed_port_conflict', error.message, 409);
      }
      if (error instanceof NetworkNamespaceConflictError) {
        throw new ManagedNetworkError('managed_namespace_conflict', error.message, 409);
      }
      throw error;
    }
  }

  private async collectReservedPorts(): Promise<Set<number>> {
    const ports = new Set(await this.registry.listReservedPorts());
    for (const network of await this.registry.listRegistered()) {
      try {
        const configPath = await realpath(network.configPath);
        const snapshot = readFabricComposeConfig(network.id, configPath);
        for (const port of collectPublishedHostPorts(snapshot)) ports.add(port);
      } catch {
        // An unavailable imported workspace must not prevent creating an unrelated network.
      }
    }
    return ports;
  }

  private async createWorkspace(
    workspaceRoot: string,
    configYaml: string,
    composeProject: string,
  ): Promise<void> {
    try {
      await Promise.all([
        access(path.join(this.driverTemplateRoot, 'network.sh'), constants.X_OK),
        access(path.join(this.driverTemplateRoot, 'upgrade_chaincode.sh'), constants.X_OK),
        access(path.join(this.driverTemplateRoot, 'smart_contract_execute.sh'), constants.X_OK),
        access(path.join(this.driverTemplateRoot, 'core-template.yaml'), constants.R_OK),
        access(path.join(this.driverTemplateRoot, 'script'), constants.R_OK),
        access(path.join(this.driverTemplateRoot, 'bin'), constants.R_OK),
      ]);
    } catch {
      throw new ManagedNetworkError(
        'managed_driver_template_unavailable',
        'The Fabric Compose driver template or binaries are unavailable.',
        500,
      );
    }

    await mkdir(this.managedNetworkRoot, { recursive: true });
    try {
      await mkdir(workspaceRoot);
    } catch {
      throw new ManagedNetworkError(
        'managed_workspace_exists',
        `Managed workspace "${workspaceRoot}" already exists.`,
        409,
      );
    }

    try {
      await Promise.all([
        mkdir(path.join(workspaceRoot, 'config'), { recursive: true }),
        mkdir(path.join(workspaceRoot, 'docker'), { recursive: true }),
        mkdir(path.join(workspaceRoot, 'chaincode'), { recursive: true }),
        cp(
          path.join(this.driverTemplateRoot, 'network.sh'),
          path.join(workspaceRoot, 'network.sh'),
        ),
        cp(
          path.join(this.driverTemplateRoot, 'upgrade_chaincode.sh'),
          path.join(workspaceRoot, 'upgrade_chaincode.sh'),
        ),
        cp(
          path.join(this.driverTemplateRoot, 'smart_contract_execute.sh'),
          path.join(workspaceRoot, 'smart_contract_execute.sh'),
        ),
        cp(
          path.join(this.driverTemplateRoot, 'core-template.yaml'),
          path.join(workspaceRoot, 'core-template.yaml'),
        ),
        cp(path.join(this.driverTemplateRoot, 'script'), path.join(workspaceRoot, 'script'), {
          recursive: true,
        }),
        symlink(path.join(this.driverTemplateRoot, 'bin'), path.join(workspaceRoot, 'bin'), 'dir'),
      ]);
      await Promise.all([
        writeFile(path.join(workspaceRoot, 'config', 'orgs.yaml'), configYaml, 'utf8'),
        writeFile(
          path.join(workspaceRoot, '.env'),
          `COMPOSE_PROJECT_NAME=${composeProject}\n`,
          'utf8',
        ),
      ]);
    } catch (error) {
      await rm(workspaceRoot, { recursive: true, force: true });
      throw new ManagedNetworkError(
        'managed_workspace_generation_failed',
        error instanceof Error ? error.message : 'The managed workspace could not be generated.',
        500,
      );
    }
  }
}

type ManagedNames = {
  ordererHosts: string[];
  peerHosts: Record<string, string[]>;
  peerCAContainers: Record<string, string>;
  ordererCAContainer: string;
  containerNames: string[];
};

function buildManagedNames(
  request: CreateManagedNetworkRequest,
  envPrefix: string,
): ManagedNames {
  const ordererHosts = Array.from(
    { length: request.ordererCount },
    (_, index) => `${envPrefix.toLowerCase()}-orderer${index + 1}.${request.domain}`,
  );
  const peerHosts = Object.fromEntries(
    request.peerOrganizations.map((organization) => [
      organization.name,
      Array.from(
        { length: organization.peerCount },
        (_, index) =>
          `${envPrefix}-peer${index}.${organization.name}.${request.domain}`,
      ),
    ]),
  );
  const peerCAContainers = Object.fromEntries(
    request.peerOrganizations.map((organization) => [
      organization.name,
      `${envPrefix}-ca_${organization.name}`,
    ]),
  );
  const ordererCAContainer = `${envPrefix}-ca_orderer`;
  return {
    ordererHosts,
    peerHosts,
    peerCAContainers,
    ordererCAContainer,
    containerNames: [
      ...ordererHosts,
      ...Object.values(peerHosts).flat(),
      ...Object.values(peerCAContainers),
      ordererCAContainer,
    ],
  };
}

function buildManagedConfig(
  request: CreateManagedNetworkRequest,
  dockerNetwork: string,
  composeProject: string,
  envPrefix: string,
  names: ManagedNames,
  ports: ManagedNetworkPortPlan,
  fabricVersion: string,
  fabricCaVersion: string,
) {
  return {
    network: {
      domain: request.domain,
      tls_enabled: true,
      aggregate_all_tls_roots: true,
      name: dockerNetwork,
      id: request.id,
      env_prefix: envPrefix,
      network_port__start: 0,
      namespace_containers: true,
      compose_project: composeProject,
      remove_docker_network_on_down: true,
      fabric_version: fabricVersion,
      fabric_ca_version: fabricCaVersion,
    },
    ordererOrg: {
      mspid: 'OrdererMSP',
      domain: request.domain,
      ca_url: `https://localhost:${ports.ordererCA}`,
      ca_name: `${request.id}-ca-orderer`,
      ca_tls_cert: 'organizations/fabric-ca/ca-orderer/ca-cert.pem',
      ca_port: ports.ordererCA,
      nodes: names.ordererHosts.map((host, index) => ({
        name: `orderer${index + 1}`,
        host,
        port: ports.orderers[index]!.grpc,
        admin_port: ports.orderers[index]!.admin,
        operations_port: ports.orderers[index]!.operations,
      })),
      admin_password: createLocalPassword(),
    },
    peerOrgs: request.peerOrganizations.map((organization) => {
      const domain = `${organization.name}.${request.domain}`;
      const organizationPeers = ports.peers[organization.name]!;
      const peerHosts = names.peerHosts[organization.name]!;
      return {
        name: organization.name,
        mspid: organization.mspId,
        domain,
        ca_url: `https://localhost:${ports.peerCAs[organization.name]}`,
        ca_name: `${request.id}-ca-${organization.name}`,
        ca_tls_cert: `organizations/fabric-ca/${organization.name}/ca-cert.pem`,
        ca_port: ports.peerCAs[organization.name],
        peer_count: organization.peerCount,
        peers: peerHosts.map((host, index) => ({
          name: `peer${index}`,
          host,
          peer_port: organizationPeers[index]!.peer,
          chaincode_port: organizationPeers[index]!.chaincode,
          metrics_port: organizationPeers[index]!.metrics,
        })),
        anchor_peers: [
          {
            name: 'peer0',
            host: peerHosts[0],
            port: organizationPeers[0]!.peer,
          },
        ],
        admin_password: createLocalPassword(),
      };
    }),
    channels: request.channels.map((channel, index) => ({
      name: channel.name,
      profile: `ManagedChannel${index + 1}`,
      consortium: 'ManagedConsortium',
      memberOrgs: channel.memberOrganizations,
    })),
    profiles: { genesis: 'ManagedOrdererGenesis' },
  };
}

function createLocalPassword(): string {
  return randomBytes(18).toString('base64url');
}

async function dockerObjectExists(args: string[]): Promise<boolean> {
  try {
    await execFileAsync('docker', args, { timeout: 5_000, encoding: 'utf8' });
    return true;
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : '';
    if (/no such (network|object|container)/i.test(stderr)) {
      return false;
    }
    const message = error instanceof Error ? error.message : 'Unknown Docker CLI error.';
    throw new ManagedNetworkError(
      'managed_docker_unavailable',
      `Docker namespace check failed: ${message}`,
      503,
    );
  }
}
