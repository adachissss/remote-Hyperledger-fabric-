import {
  NetworkNodeListResponseSchema,
  NetworkNodeSchema,
  type NetworkNode,
  type NetworkNodeListResponse,
  type NetworkNodeRuntime,
  type NetworkNodeRuntimeState,
  type NetworkTopologyResponse,
} from '@plus-fabric/shared';

import type {
  DockerContainerObservation,
  DockerRuntime,
  DockerRuntimeProbe,
} from './docker-runtime.js';
import { NetworkImportError, type NetworkImportService } from './network-import-service.js';
import type { ServiceProbe } from './service-probe.js';

export class NetworkObservatoryService {
  constructor(
    private readonly networkImportService: NetworkImportService,
    private readonly dockerRuntime: DockerRuntime,
    private readonly serviceProbe: ServiceProbe,
  ) {}

  async getTopology(networkId: string): Promise<NetworkTopologyResponse> {
    return (await this.networkImportService.getSnapshot(networkId)).topology;
  }

  async getNodes(networkId: string): Promise<NetworkNodeListResponse> {
    const topology = await this.getTopology(networkId);
    const probe = await this.dockerRuntime.probe();
    const items = await Promise.all(
      topology.nodes.map((node) => this.observeNode(node, topology.dockerNetwork, probe)),
    );
    const dockerAvailable = probe.available && items.every((item) => item.runtime.dockerAvailable);

    return NetworkNodeListResponseSchema.parse({
      networkId,
      observedAt: new Date().toISOString(),
      dockerAvailable,
      items,
      total: items.length,
      running: items.filter((item) => item.runtime.containerRunning).length,
      stopped: items.filter(
        (item) => item.runtime.containerExists && !item.runtime.containerRunning,
      ).length,
      missing: items.filter((item) => item.runtime.state === 'missing').length,
      reachable: items.filter((item) => item.runtime.serviceReachable === true).length,
      unreachable: items.filter((item) => item.runtime.serviceReachable === false).length,
    });
  }

  async getNode(networkId: string, nodeId: string): Promise<NetworkNode> {
    const topology = await this.getTopology(networkId);
    const node = topology.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new NetworkImportError(
        'node_not_found',
        `Node "${nodeId}" is not configured in network "${networkId}".`,
        404,
      );
    }

    const probe = await this.dockerRuntime.probe();
    return this.observeNode(node, topology.dockerNetwork, probe);
  }

  private async observeNode(
    node: NetworkTopologyResponse['nodes'][number],
    dockerNetwork: string,
    probe: DockerRuntimeProbe,
  ): Promise<NetworkNode> {
    if (!probe.available) {
      return NetworkNodeSchema.parse({
        ...node,
        runtime: unavailableRuntime(probe.reason),
      });
    }

    try {
      const observation = await this.dockerRuntime.inspectContainer(
        node.containerName,
        dockerNetwork,
      );
      const runtime = observation
        ? await this.withServiceReachability(node, observedRuntime(observation))
        : missingRuntime();
      return NetworkNodeSchema.parse({ ...node, runtime });
    } catch {
      return NetworkNodeSchema.parse({
        ...node,
        runtime: unavailableRuntime(
          'Docker became unavailable while the control plane was reading this container.',
        ),
      });
    }
  }

  private async withServiceReachability(
    node: NetworkTopologyResponse['nodes'][number],
    runtime: NetworkNodeRuntime,
  ): Promise<NetworkNodeRuntime> {
    if (!runtime.containerRunning) {
      return { ...runtime, serviceReachable: false };
    }

    const primaryEndpointKind =
      node.type === 'ca' ? 'ca' : node.type === 'couchdb' ? 'couchdb' : 'grpc';
    const endpoint = node.endpoints.find((candidate) => candidate.kind === primaryEndpointKind);
    if (!endpoint) return runtime;

    let reachable = false;
    try {
      reachable = (
        await this.serviceProbe.probe({
          host: '127.0.0.1',
          port: endpoint.port,
          timeoutMs: 1_500,
        })
      ).reachable;
    } catch {
      reachable = false;
    }

    return {
      ...runtime,
      state: reachable ? runtime.state : 'degraded',
      serviceReachable: reachable,
      degradedReason: reachable
        ? runtime.degradedReason
        : runtime.degradedReason ??
          `The container is running, but its ${endpoint.kind} service port is unreachable.`,
    };
  }
}

function unavailableRuntime(reason: string | null): NetworkNodeRuntime {
  return {
    state: 'docker-unavailable',
    dockerAvailable: false,
    containerExists: false,
    containerRunning: false,
    serviceReachable: null,
    fabricReady: null,
    status: null,
    health: null,
    image: null,
    containerId: null,
    startedAt: null,
    finishedAt: null,
    restartCount: null,
    networkAttached: null,
    ipAddress: null,
    degradedReason: reason ?? 'Docker is unavailable to the control plane.',
  };
}

function missingRuntime(): NetworkNodeRuntime {
  return {
    state: 'missing',
    dockerAvailable: true,
    containerExists: false,
    containerRunning: false,
    serviceReachable: false,
    fabricReady: null,
    status: null,
    health: null,
    image: null,
    containerId: null,
    startedAt: null,
    finishedAt: null,
    restartCount: null,
    networkAttached: false,
    ipAddress: null,
    degradedReason: 'The node is configured, but its Docker container does not exist.',
  };
}

function observedRuntime(observation: DockerContainerObservation): NetworkNodeRuntime {
  const observedState = runtimeState(observation);
  const networkReason = observation.networkAttached
    ? null
    : 'The container is not attached to the network registered for this Fabric network.';
  const healthReason =
    observation.health && observation.health !== 'healthy'
      ? `Docker reports container health as ${observation.health}.`
      : null;

  return {
    state:
      observation.running && (networkReason !== null || healthReason !== null)
        ? 'degraded'
        : observedState,
    dockerAvailable: true,
    containerExists: true,
    containerRunning: observation.running,
    serviceReachable: null,
    fabricReady: null,
    status: observation.status,
    health: observation.health,
    image: observation.image,
    containerId: observation.containerId,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
    restartCount: observation.restartCount,
    networkAttached: observation.networkAttached,
    ipAddress: observation.ipAddress,
    degradedReason: networkReason ?? healthReason,
  };
}

function runtimeState(observation: DockerContainerObservation): NetworkNodeRuntimeState {
  if (observation.paused) return 'paused';
  if (observation.restarting) return 'restarting';
  if (observation.running) return 'running';

  switch (observation.status) {
    case 'created':
    case 'exited':
    case 'dead':
      return observation.status;
    default:
      return 'unknown';
  }
}
