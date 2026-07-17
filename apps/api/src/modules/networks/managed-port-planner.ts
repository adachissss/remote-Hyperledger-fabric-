import { createServer } from 'node:net';

import type { CreateManagedNetworkRequest } from '@plus-fabric/shared';

export type ManagedOrdererPorts = {
  grpc: number;
  admin: number;
  operations: number;
};

export type ManagedPeerPorts = {
  peer: number;
  chaincode: number;
  metrics: number;
};

export type ManagedNetworkPortPlan = {
  start: number;
  end: number;
  orderers: ManagedOrdererPorts[];
  peerCAs: Record<string, number>;
  ordererCA: number;
  peers: Record<string, ManagedPeerPorts[]>;
  reservedPorts: number[];
  publishedPorts: number[];
};

export interface HostPortProbe {
  isAvailable(port: number): Promise<boolean>;
}

export class TcpHostPortProbe implements HostPortProbe {
  isAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
  }
}

export class ManagedPortPlanError extends Error {
  constructor(
    readonly code: 'managed_port_conflict' | 'managed_port_range_unavailable',
    message: string,
    readonly port: number | null,
  ) {
    super(message);
    this.name = 'ManagedPortPlanError';
  }
}

export class ManagedPortPlanner {
  constructor(private readonly hostPortProbe: HostPortProbe) {}

  async plan(
    request: CreateManagedNetworkRequest,
    reservedPorts: ReadonlySet<number>,
  ): Promise<ManagedNetworkPortPlan> {
    if (request.preferredPortStart !== null) {
      const preferred = buildPortPlan(request, request.preferredPortStart);
      await this.assertAvailable(preferred, reservedPorts);
      return preferred;
    }

    const required = requiredPortCount(request);
    for (let start = 20_000; start + required - 1 <= 65_535; start += required + 16) {
      const candidate = buildPortPlan(request, start);
      if (candidate.reservedPorts.some((port) => reservedPorts.has(port))) continue;
      if (await this.arePublishedPortsAvailable(candidate.publishedPorts)) return candidate;
    }
    throw new ManagedPortPlanError(
      'managed_port_range_unavailable',
      'No contiguous host port range is available for this network topology.',
      null,
    );
  }

  private async assertAvailable(
    plan: ManagedNetworkPortPlan,
    reservedPorts: ReadonlySet<number>,
  ): Promise<void> {
    const reservedConflict = plan.reservedPorts.find((port) => reservedPorts.has(port));
    if (reservedConflict !== undefined) {
      throw new ManagedPortPlanError(
        'managed_port_conflict',
        `Port ${reservedConflict} is reserved by another registered network.`,
        reservedConflict,
      );
    }
    for (const port of plan.publishedPorts) {
      if (!(await this.hostPortProbe.isAvailable(port))) {
        throw new ManagedPortPlanError(
          'managed_port_conflict',
          `Port ${port} is already in use on the control-plane host.`,
          port,
        );
      }
    }
  }

  private async arePublishedPortsAvailable(ports: number[]): Promise<boolean> {
    for (const port of ports) {
      if (!(await this.hostPortProbe.isAvailable(port))) return false;
    }
    return true;
  }
}

function requiredPortCount(request: CreateManagedNetworkRequest): number {
  const peerCount = request.peerOrganizations.reduce(
    (total, organization) => total + organization.peerCount,
    0,
  );
  return request.ordererCount * 3 + request.peerOrganizations.length + 1 + peerCount * 3;
}

function buildPortPlan(
  request: CreateManagedNetworkRequest,
  start: number,
): ManagedNetworkPortPlan {
  let cursor = start;
  const orderers = Array.from({ length: request.ordererCount }, () => ({
    grpc: cursor++,
    admin: cursor++,
    operations: cursor++,
  }));
  const peerCAs = Object.fromEntries(
    request.peerOrganizations.map((organization) => [organization.name, cursor++]),
  );
  const ordererCA = cursor++;
  const peers = Object.fromEntries(
    request.peerOrganizations.map((organization) => [
      organization.name,
      Array.from({ length: organization.peerCount }, () => ({
        peer: cursor++,
        chaincode: cursor++,
        metrics: cursor++,
      })),
    ]),
  );
  const reservedPorts = Array.from({ length: cursor - start }, (_, index) => start + index);
  if (reservedPorts.at(-1)! > 65_535) {
    throw new ManagedPortPlanError(
      'managed_port_range_unavailable',
      'The requested port range exceeds 65535.',
      reservedPorts.at(-1)!,
    );
  }
  const publishedPorts = [
    ...orderers.flatMap((orderer) => [orderer.grpc, orderer.admin, orderer.operations]),
    ...Object.values(peerCAs),
    ordererCA,
    ...Object.values(peers).flatMap((organizationPeers) =>
      organizationPeers.flatMap((peer) => [peer.peer, peer.metrics]),
    ),
  ];
  return {
    start,
    end: cursor - 1,
    orderers,
    peerCAs,
    ordererCA,
    peers,
    reservedPorts,
    publishedPorts,
  };
}
