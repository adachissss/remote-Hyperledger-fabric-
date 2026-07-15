import { readFileSync } from 'node:fs';

import {
  RedactedNetworkConfigurationSchema,
  type RedactedNetworkConfiguration,
} from '@plus-fabric/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const RawNodeSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
});

const RawPeerOrganizationSchema = z.object({
  name: z.string().min(1),
  mspid: z.string().min(1),
  domain: z.string().min(1),
  peer_count: z.number().int().nonnegative().optional(),
  anchor_peers: z.array(RawNodeSchema).default([]),
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
    tls_enabled: z.boolean().default(true),
  }),
  ordererOrg: z.object({
    nodes: z.array(RawNodeSchema).min(1),
  }),
  peerOrgs: z.array(RawPeerOrganizationSchema),
  channels: z.array(RawChannelSchema).default([]),
});

export type FabricComposeConfigSnapshot = {
  redacted: RedactedNetworkConfiguration;
  organizationCount: number;
  channelCount: number;
  nodeCount: number;
  dockerNetwork: string;
};

export function readFabricComposeConfig(
  networkId: string,
  configPath: string,
): FabricComposeConfigSnapshot {
  const rawDocument = parseYaml(readFileSync(configPath, 'utf8')) as unknown;
  const config = RawFabricComposeConfigSchema.parse(rawDocument);

  const peerOrganizations = config.peerOrgs.map((organization) => ({
    name: organization.name,
    mspId: organization.mspid,
    domain: organization.domain,
    peerCount: organization.peer_count ?? organization.anchor_peers.length,
    anchorPeers: organization.anchor_peers,
  }));
  const channels = config.channels.map((channel) => ({
    name: channel.name,
    profile: channel.profile ?? null,
    memberOrganizations: channel.memberOrgs,
  }));
  const peerCount = peerOrganizations.reduce(
    (total, organization) => total + organization.peerCount,
    0,
  );

  return {
    redacted: RedactedNetworkConfigurationSchema.parse({
      networkId,
      networkName: config.network.name,
      domain: config.network.domain,
      dockerNetwork: config.network.name,
      tlsEnabled: config.network.tls_enabled,
      orderers: config.ordererOrg.nodes,
      peerOrganizations,
      channels,
    }),
    organizationCount: peerOrganizations.length,
    channelCount: channels.length,
    nodeCount: peerCount + config.ordererOrg.nodes.length,
    dockerNetwork: config.network.name,
  };
}
