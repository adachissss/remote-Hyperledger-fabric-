import { readFileSync } from 'node:fs';

import {
  NetworkTopologyResponseSchema,
  RedactedNetworkConfigurationSchema,
  type NetworkTopologyNode,
  type NetworkTopologyOrganization,
  type NetworkTopologyResponse,
  type RedactedNetworkConfiguration,
} from '@plus-fabric/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const RawAddressNodeSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  admin_port: z.number().int().min(1).max(65535).optional(),
  operations_port: z.number().int().min(1).max(65535).optional(),
});

const RawPeerOverrideSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  peer_port: z.number().int().min(1).max(65535).optional(),
  chaincode_port: z.number().int().min(1).max(65535).optional(),
  metrics_port: z.number().int().min(1).max(65535).optional(),
});

const RawPeerOrganizationSchema = z.object({
  name: z.string().min(1),
  mspid: z.string().min(1),
  domain: z.string().min(1),
  ca_url: z.string().min(1).optional(),
  ca_name: z.string().min(1).optional(),
  ca_port: z.number().int().min(1).max(65535).optional(),
  peer_count: z.number().int().nonnegative().optional(),
  peers: z.array(RawPeerOverrideSchema).default([]),
  anchor_peers: z.array(RawAddressNodeSchema).default([]),
});

const RawChannelSchema = z.object({
  name: z.string().min(1),
  profile: z.string().min(1).optional(),
  memberOrgs: z.array(z.string().min(1)).default([]),
});

const RawFabricComposeConfigSchema = z.object({
  network: z.object({
    name: z.string().min(1),
    domain: z.string().min(1),
    env_prefix: z.string().min(1).optional(),
    network_port__start: z.number().int().nonnegative().default(0),
    tls_enabled: z.boolean().default(true),
  }),
  ordererOrg: z.object({
    name: z.string().min(1).optional(),
    mspid: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    ca_url: z.string().min(1).optional(),
    ca_name: z.string().min(1).optional(),
    ca_port: z.number().int().min(1).max(65535).optional(),
    nodes: z.array(RawAddressNodeSchema).min(1),
  }),
  peerOrgs: z.array(RawPeerOrganizationSchema),
  channels: z.array(RawChannelSchema).default([]),
});

export type FabricComposeConfigSnapshot = {
  redacted: RedactedNetworkConfiguration;
  topology: NetworkTopologyResponse;
  organizationCount: number;
  channelCount: number;
  nodeCount: number;
  dockerNetwork: string;
  envPrefix: string;
  ordererDomain: string;
};

export function readFabricComposeConfig(
  networkId: string,
  configPath: string,
): FabricComposeConfigSnapshot {
  const rawDocument = parseYaml(readFileSync(configPath, 'utf8')) as unknown;
  const config = RawFabricComposeConfigSchema.parse(rawDocument);
  const tlsProtocol = config.network.tls_enabled ? ('grpcs' as const) : ('grpc' as const);
  const envPrefix = config.network.env_prefix ?? config.network.name;
  const ordererMspId = config.ordererOrg.mspid ?? 'OrdererMSP';
  const ordererDomain = config.ordererOrg.domain ?? config.network.domain;
  const ordererOrganizationId = 'orderer-org';
  const ordererOrganizationName = config.ordererOrg.name ?? 'Orderer organization';

  const ordererNodes: NetworkTopologyNode[] = config.ordererOrg.nodes.map((node, index) => {
    const adminPort = node.admin_port ?? node.port + 3;
    const operationsPort = node.operations_port ?? 9443 + index;
    return {
      id: node.host,
      type: 'orderer',
      name: node.name ?? node.host.split('.')[0] ?? node.host,
      organizationId: ordererOrganizationId,
      organizationName: ordererOrganizationName,
      mspId: ordererMspId,
      host: node.host,
      containerName: node.host,
      endpoints: [
        {
          kind: 'grpc',
          protocol: tlsProtocol,
          host: node.host,
          port: node.port,
          internalPort: node.port,
        },
        {
          kind: 'admin',
          protocol: tlsProtocol,
          host: node.host,
          port: adminPort,
          internalPort: adminPort,
        },
        {
          kind: 'operations',
          protocol: 'http',
          host: node.host,
          port: operationsPort,
          internalPort: operationsPort,
        },
      ],
    };
  });

  const peerNodes: NetworkTopologyNode[] = [];
  const peerOrganizations: NetworkTopologyOrganization[] = [];

  config.peerOrgs.forEach((organization, organizationIndex) => {
    const peerCount =
      organization.peer_count ??
      Math.max(organization.peers.length, organization.anchor_peers.length);
    const organizationId = `peer-org-${organization.name}`;
    const organizationNodes: NetworkTopologyNode[] = [];

    for (let peerIndex = 0; peerIndex < peerCount; peerIndex += 1) {
      const override = organization.peers[peerIndex];
      const anchor = organization.anchor_peers.find((candidate) =>
        candidate.host.includes(`peer${peerIndex}.`),
      );
      const peerPort = override?.peer_port ?? peerPortFor(organizationIndex, peerIndex, 51);
      const metricsPort =
        override?.metrics_port ?? peerPortFor(organizationIndex, peerIndex, 55);
      const host =
        override?.host ??
        anchor?.host ??
        `${envPrefix}-peer${peerIndex}.${organization.domain}`;
      const node: NetworkTopologyNode = {
        id: host,
        type: 'peer',
        name: override?.name ?? `peer${peerIndex}`,
        organizationId,
        organizationName: organization.name,
        mspId: organization.mspid,
        host,
        containerName: host,
        endpoints: [
          {
            kind: 'grpc',
            protocol: tlsProtocol,
            host,
            port: config.network.network_port__start + peerPort,
            internalPort: peerPort,
          },
          {
            kind: 'metrics',
            protocol: 'http',
            host,
            port: config.network.network_port__start + metricsPort,
            internalPort: metricsPort,
          },
        ],
      };
      organizationNodes.push(node);
      peerNodes.push(node);
    }

    const caNode = buildCaNode({
      organizationId,
      organizationName: organization.name,
      mspId: organization.mspid,
      containerName: `ca_${organization.name}`,
      caName: organization.ca_name,
      caUrl: organization.ca_url,
      hostPort:
        organization.ca_port ??
        portFromUrl(organization.ca_url) ??
        7054 + organizationIndex * 1000,
    });
    if (caNode) {
      organizationNodes.push(caNode);
      peerNodes.push(caNode);
    }

    peerOrganizations.push({
      id: organizationId,
      name: organization.name,
      type: 'peer',
      mspId: organization.mspid,
      domain: organization.domain,
      nodeIds: organizationNodes.map((node) => node.id),
    });
  });

  const ordererCa = buildCaNode({
    organizationId: ordererOrganizationId,
    organizationName: ordererOrganizationName,
    mspId: ordererMspId,
    containerName: 'ca_orderer',
    caName: config.ordererOrg.ca_name,
    caUrl: config.ordererOrg.ca_url,
    hostPort:
      config.ordererOrg.ca_port ??
      portFromUrl(config.ordererOrg.ca_url) ??
      7054 + config.peerOrgs.length * 1000,
  });
  if (ordererCa) ordererNodes.push(ordererCa);

  const nodes = [...ordererNodes, ...peerNodes];
  ensureUniqueNodeIds(nodes);

  const channels = config.channels.map((channel) => ({
    name: channel.name,
    profile: channel.profile ?? null,
    memberOrganizations: channel.memberOrgs,
  }));
  const organizations: NetworkTopologyOrganization[] = [
    {
      id: ordererOrganizationId,
      name: ordererOrganizationName,
      type: 'orderer',
      mspId: ordererMspId,
      domain: ordererDomain,
      nodeIds: ordererNodes.map((node) => node.id),
    },
    ...peerOrganizations,
  ];
  const topology = NetworkTopologyResponseSchema.parse({
    networkId,
    networkName: config.network.name,
    domain: config.network.domain,
    dockerNetwork: config.network.name,
    tlsEnabled: config.network.tls_enabled,
    organizations,
    channels,
    nodes,
  });

  const redactedPeerOrganizations = config.peerOrgs.map((organization) => ({
    name: organization.name,
    mspId: organization.mspid,
    domain: organization.domain,
    peerCount:
      organization.peer_count ??
      Math.max(organization.peers.length, organization.anchor_peers.length),
    anchorPeers: organization.anchor_peers.map((peer) => ({
      name: peer.name ?? peer.host.split('.')[0] ?? peer.host,
      host: peer.host,
      port: peer.port,
    })),
  }));

  return {
    redacted: RedactedNetworkConfigurationSchema.parse({
      networkId,
      networkName: config.network.name,
      domain: config.network.domain,
      dockerNetwork: config.network.name,
      tlsEnabled: config.network.tls_enabled,
      orderers: config.ordererOrg.nodes.map((node) => ({
        name: node.name ?? node.host.split('.')[0] ?? node.host,
        host: node.host,
        port: node.port,
      })),
      peerOrganizations: redactedPeerOrganizations,
      channels,
    }),
    topology,
    organizationCount: peerOrganizations.length,
    channelCount: channels.length,
    nodeCount: nodes.length,
    dockerNetwork: config.network.name,
    envPrefix,
    ordererDomain,
  };
}

function peerPortFor(organizationIndex: number, peerIndex: number, offset: number): number {
  return 7000 + organizationIndex * 100 + peerIndex * 10 + offset;
}

function buildCaNode(input: {
  organizationId: string;
  organizationName: string;
  mspId: string;
  containerName: string;
  caName: string | undefined;
  caUrl: string | undefined;
  hostPort: number;
}): NetworkTopologyNode | null {
  if (!input.caName && !input.caUrl) return null;

  return {
    id: input.containerName,
    type: 'ca',
    name: input.caName ?? input.containerName,
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    mspId: input.mspId,
    host: input.containerName,
    containerName: input.containerName,
    endpoints: [
      {
        kind: 'ca',
        protocol: protocolFromUrl(input.caUrl),
        host: hostFromUrl(input.caUrl) ?? 'localhost',
        port: input.hostPort,
        internalPort: 7054,
      },
    ],
  };
}

function portFromUrl(value: string | undefined): number | null {
  if (!value) return null;
  try {
    const port = new URL(value).port;
    return port ? Number(port) : null;
  } catch {
    return null;
  }
}

function hostFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function protocolFromUrl(value: string | undefined): 'http' | 'https' {
  if (!value) return 'https';
  try {
    return new URL(value).protocol === 'http:' ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

function ensureUniqueNodeIds(nodes: NetworkTopologyNode[]): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      throw new Error(`The configured container name "${node.id}" is not unique.`);
    }
    ids.add(node.id);
  }
}
